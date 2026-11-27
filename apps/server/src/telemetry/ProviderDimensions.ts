import type {
  ModelSelection,
  OrchestrationV2ThreadShell,
  ServerProvider,
} from "@t3tools/contracts";

// Codex and Claude include early-access names, so only their public families qualify.
const VENDOR_CATALOGS: ReadonlyMap<string, RegExp | undefined> = new Map([
  ["codex", /^gpt-/u],
  ["claudeAgent", /^claude-/u],
  ["cursor", undefined],
  ["grok", undefined],
  ["antigravity", undefined],
]);

export interface ProviderDimensions {
  readonly provider: string;
  readonly model?: string;
}

/**
 * Anonymous provider and model for a model selection. Instance ids are
 * user-defined, so only the driver kind is reported. The model is reported
 * by its public vendor catalog name or the non-identifying custom:<driver> label.
 */
export function providerDimensions(
  providers: ReadonlyArray<ServerProvider>,
  selection: Pick<ModelSelection, "instanceId" | "model">,
): ProviderDimensions {
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (provider === undefined) return { provider: "unknown" };
  if (selection.model === "") return { provider: provider.driver };
  const custom = { provider: provider.driver, model: `custom:${provider.driver}` };
  if (
    !VENDOR_CATALOGS.has(provider.driver) ||
    provider.auth.endpoint !== undefined ||
    provider.auth.type === "customEndpoint" ||
    provider.auth.type === "bedrock"
  )
    return custom;
  const baseModel =
    provider.driver === "antigravity"
      ? selection.model.replace(/-(?:minimal|low|medium|high|xhigh|max)$/u, "")
      : selection.model;
  const model =
    provider.models.find((candidate) => candidate.slug === selection.model) ??
    provider.models.find((candidate) => !candidate.isCustom && candidate.slug === baseModel) ??
    provider.models.find(
      (candidate) => !candidate.isCustom && candidate.aliases?.includes(selection.model),
    );
  const family = VENDOR_CATALOGS.get(provider.driver);
  return model !== undefined && !model.isCustom && (family === undefined || family.test(model.slug))
    ? { provider: provider.driver, model: model.slug }
    : custom;
}

/** The thread fields agent analytics reads. Ids are used for lookups, never reported. */
export type AgentThread = Pick<
  OrchestrationV2ThreadShell,
  "modelSelection" | "runtimeMode" | "interactionMode" | "createdBy" | "creationSource" | "lineage"
>;

type Fields = Readonly<Record<string, unknown>>;

const asFields = (value: unknown): Fields =>
  typeof value === "object" && value !== null ? (value as Fields) : {};

const stringField = (fields: Fields, key: string) =>
  typeof fields[key] === "string" ? (fields[key] as string) : undefined;

/** A string from the tool input only when it is one of the schema's literals. */
const oneOf = (value: string | undefined, allowed: ReadonlyArray<string>) =>
  value !== undefined && allowed.includes(value) ? value : undefined;

/**
 * Whether two resolved providers differ. Unresolved selections compare as
 * unknown rather than as a cross-provider handoff.
 */
export const crossProvider = (caller: string, target: string) =>
  caller === "unknown" || target === "unknown" ? undefined : caller !== target;

const defined = (entries: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined));

/**
 * How deep a thread sits in a delegation tree: 0 for a top-level thread, 1 for
 * its subagent, and so on. Forks are top-level threads of their own. Depth is
 * counted by walking parents, capped so a corrupt lineage cannot loop.
 */
export const MAX_REPORTED_DEPTH = 5;

/**
 * Who started the work that made this call. Scheduled runs keep the task
 * creator's provenance, so the run's message marks them instead.
 */
function callerOrigin(input: {
  readonly thread: Pick<AgentThread, "createdBy">;
  readonly scheduledRun: boolean;
}) {
  if (input.scheduledRun) return "scheduler";
  if (input.thread.createdBy === "agent") return "agent";
  return input.thread.createdBy === "system" ? "system" : "user";
}

/**
 * Settings for a handoff, recorded only as closed enums and booleans derived
 * from the tool's arguments and result. Prompts, titles, and ids are never
 * recorded.
 */
export function handoffSettings(tool: string, args: unknown, result: unknown): Fields {
  const input = asFields(args);
  const output = asFields(result);
  switch (tool) {
    case "delegate_task":
      return defined({
        targetChosen: input.target !== undefined,
        // Rejected calls are recorded too, so input strings must match a literal.
        mode: oneOf(stringField(input, "mode"), ["async", "wait"]) ?? "async",
        ...(output.waitTimedOut === true ? { waitTimedOut: true } : {}),
      });
    case "create_threads": {
      const threads = Array.isArray(input.threads) ? input.threads : [];
      return {
        batchSize: threads.length,
        targetChosen: threads.some((thread) => asFields(thread).target !== undefined),
      };
    }
    case "cox_thread_launch":
      return defined({
        targetChosen: input.modelSelection !== undefined,
        workspace:
          input.scratch === true
            ? "scratch"
            : (oneOf(stringField(asFields(input.workspaceStrategy), "type"), [
                "root",
                "worktree",
                "existing_worktree",
              ]) ?? "root"),
      });
    case "cox_thread_send":
      return defined({
        delivery: oneOf(stringField(output, "delivery"), [
          "started",
          "queued",
          "steered",
          "restarted",
        ]),
      });
    case "cox_thread_send_attachments":
      return { delivery: "auto" };
    case "schedule_task": {
      // Omitting the input lets the server decide, so read the saved task.
      const bound = output.boundThreadId;
      return bound === null || typeof bound === "string"
        ? { bindToCurrentThread: bound !== null }
        : {};
    }
    default:
      return {};
  }
}

const ERROR_CODE_SHAPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Outcome of a tool call, with the stable failure code when the call failed. */
export function toolOutcome(
  result:
    | { readonly isError?: boolean | undefined; readonly structuredContent?: unknown }
    | undefined,
) {
  if (result === undefined) return { outcome: "error", errorCode: "exception" };
  const content = asFields(result.structuredContent);
  // T3 tool failures are declared errors whose structured content carries a
  // closed `code`; the MCP layer does not always set isError for them.
  const code = stringField(content, "code") ?? stringField(asFields(content.error), "_tag");
  if (result.isError === true || (content._tag !== undefined && code !== undefined)) {
    // Codes and tags are identifiers; anything else may be a message or a value, which stays in
    // local traces rather than analytics.
    return {
      outcome: "error",
      errorCode: code !== undefined && ERROR_CODE_SHAPE.test(code) ? code : "unknown",
    };
  }
  return { outcome: "ok" };
}

/**
 * Event properties for an agent tool call: the calling agent, and when the call
 * handed work to other threads, the agents running them. Each target counts
 * once, so a create_threads batch on two providers reports both.
 */
export function agentToolProperties(input: {
  readonly tool: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly caller: AgentThread | undefined;
  readonly callerProviderInstanceId?: ModelSelection["instanceId"];
  readonly callerDepth?: number;
  readonly callerScheduledRun?: boolean;
  readonly targets: ReadonlyArray<AgentThread>;
  readonly outcome: Fields;
  readonly settings?: Fields;
  readonly durationMs?: number;
}): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const caller =
    input.caller !== undefined
      ? providerDimensions(input.providers, input.caller.modelSelection)
      : input.callerProviderInstanceId !== undefined
        ? {
            provider: providerDimensions(input.providers, {
              instanceId: input.callerProviderInstanceId,
              model: "",
            }).provider,
          }
        : { provider: "unknown" };
  const base = defined({
    tool: input.tool,
    callerProvider: caller.provider,
    callerModel: caller.model,
    callerOrigin:
      input.caller === undefined
        ? undefined
        : callerOrigin({
            thread: input.caller,
            scheduledRun: input.callerScheduledRun === true,
          }),
    callerDepth:
      input.callerDepth === undefined ? undefined : Math.min(input.callerDepth, MAX_REPORTED_DEPTH),
    durationMs: input.durationMs,
    ...input.outcome,
    ...input.settings,
  });
  if (input.targets.length === 0) return [base];
  return input.targets.map((thread) => {
    const target = providerDimensions(input.providers, thread.modelSelection);
    return defined({
      ...base,
      targetProvider: target.provider,
      targetModel: target.model,
      targetRuntimeMode: thread.runtimeMode,
      targetInteractionMode: thread.interactionMode,
      crossProvider: crossProvider(caller.provider, target.provider),
    });
  });
}
