import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  makePiRpcConnection,
  PiRpcError,
  type PiRpcRecord,
  type PiRpcSpawnOptions,
} from "@t3tools/provider-pi/server";
import { omoTaskTranscript } from "./subagents.ts";
import { OmoDagUpdates, omoDagRunIdsFromRpc, omoDagSnapshotFromRpc } from "./dag.ts";

const terminalStates = new Set(["done", "failed", "cancelled"]);
const decodeAllowedModels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const encodeTaskState = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

export function omoTaskIsQuiescent(value: unknown): boolean {
  return ["completed", "error", "cancelled", "interrupted", "lost", "paused"].includes(
    String(record(value).status),
  );
}

function omoAwaitingBlockedGoal(value: unknown): boolean {
  const lifecycle = record(value);
  const waits = record(lifecycle.waitingOn);
  return (
    lifecycle.state === "waiting_human" &&
    lifecycle.runActive !== true &&
    lifecycle.runPaused !== true &&
    lifecycle.activity === undefined &&
    Array.isArray(lifecycle.holds) &&
    lifecycle.holds.length === 0 &&
    waits.children === 0 &&
    Array.isArray(waits.background) &&
    waits.background.length === 0 &&
    Array.isArray(waits.human) &&
    waits.human.length > 0 &&
    waits.human.every((wait) => record(wait).kind === "goal_blocked")
  );
}

export class OmoLifecycle {
  private readonly ephemeral: boolean;

  constructor(ephemeral = false) {
    this.ephemeral = ephemeral;
  }
  private sessionId: string | undefined;
  private sequence = -1;
  private runId: string | undefined;
  private idle = false;
  private latest: PiRpcRecord | undefined;
  private readonly completions = new Set<string>();

  reset() {
    this.sessionId = undefined;
    this.sequence = -1;
    this.runId = undefined;
    this.idle = false;
    this.latest = undefined;
    this.completions.clear();
  }

  bind(value: unknown) {
    const state = record(value);
    if (typeof state.sessionId !== "string") return;
    if (this.sessionId !== undefined && this.sessionId !== state.sessionId) this.reset();
    this.sessionId = state.sessionId;
  }

  observe(event: PiRpcRecord): ReadonlyArray<PiRpcRecord> {
    if (event.type === "agent_start") {
      this.runId = typeof event.runId === "string" ? event.runId : undefined;
      this.idle = false;
      return [event];
    }
    if (event.type === "auto_retry_start") this.idle = false;
    if (event.type === "agent_idle") {
      this.idle = true;
      return this.latest === undefined ? [] : this.settle(this.latest);
    }
    if (event.type === "agent_settled") return [];
    if (event.type !== "session_lifecycle") return [event];
    const lifecycle = record(event.lifecycle);
    if (lifecycle.role === "child") return [];
    if (typeof lifecycle.seq !== "number" || typeof lifecycle.state !== "string") return [];
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (this.sessionId !== undefined && sessionId !== undefined && sessionId !== this.sessionId)
      return [];
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (lifecycle.seq < this.sequence) return [];
    const advanced = lifecycle.seq > this.sequence;
    this.sequence = lifecycle.seq;
    this.latest = lifecycle;
    if (!advanced && !omoAwaitingBlockedGoal(lifecycle)) return [];
    return this.settle(lifecycle);
  }

  private settle(lifecycle: PiRpcRecord): ReadonlyArray<PiRpcRecord> {
    const blockedGoal = this.idle && omoAwaitingBlockedGoal(lifecycle);
    if (
      typeof lifecycle.state !== "string" ||
      (!terminalStates.has(lifecycle.state) && !blockedGoal)
    )
      return [];
    if (lifecycle.restoring === true || (lifecycle.persisted !== true && !this.ephemeral))
      return [];
    if (
      this.runId !== undefined &&
      typeof lifecycle.runId === "string" &&
      lifecycle.runId !== this.runId
    )
      return [];
    const completionId = blockedGoal
      ? typeof lifecycle.runId === "string"
        ? `turn:${lifecycle.runId}`
        : undefined
      : lifecycle.completionId;
    if (typeof completionId !== "string" || this.completions.has(completionId)) return [];
    this.completions.add(completionId);
    if (this.completions.size > 128)
      this.completions.delete(this.completions.values().next().value!);
    return [
      ...(lifecycle.state === "failed" ||
      (blockedGoal && lifecycle.failure !== undefined && lifecycle.failure !== null)
        ? [
            {
              type: "message_end",
              message: {
                role: "assistant",
                content: [],
                stopReason: "error",
                errorMessage: "OMO Native reported that the task failed.",
              },
            },
          ]
        : []),
      { type: "agent_settled", aborted: lifecycle.state === "cancelled" },
    ];
  }
}

export function omoSessionState(value: unknown, ephemeral = false): unknown {
  const state = record(value);
  const lifecycle = record(state.lifecycle);
  if (typeof lifecycle.state !== "string")
    throw new Error("OMO Native did not expose the required session lifecycle.");
  return (terminalStates.has(lifecycle.state) ||
    (omoAwaitingBlockedGoal(lifecycle) && state.isStreaming === false)) &&
    lifecycle.restoring !== true &&
    (lifecycle.persisted === true || ephemeral || lifecycle.epoch === 0)
    ? state
    : { ...state, isStreaming: true };
}

export class OmoFailureRecovery {
  private runId: string | undefined;
  private failed = false;
  private idle = false;

  reset() {
    this.runId = undefined;
    this.failed = false;
    this.idle = false;
  }

  observe(event: PiRpcRecord): boolean {
    if (event.type === "agent_start") {
      this.reset();
      this.runId = typeof event.runId === "string" ? event.runId : undefined;
    }
    if (event.type === "message_end" && record(event.message).role === "assistant")
      this.failed = record(event.message).stopReason === "error";
    if (event.type === "auto_retry_start") this.idle = false;
    if (event.type === "agent_idle") this.idle = true;
    return (
      this.failed &&
      this.idle &&
      (event.type === "agent_idle" || event.type === "session_lifecycle")
    );
  }

  stranded(value: unknown): boolean {
    return (
      this.failed &&
      this.idle &&
      this.runId !== undefined &&
      record(record(value).lifecycle).runId === this.runId &&
      omoStrandedFailure(value)
    );
  }
}

function omoStrandedFailure(value: unknown): boolean {
  const state = record(value);
  const lifecycle = record(state.lifecycle);
  const waits = record(lifecycle.waitingOn);
  const background = Array.isArray(waits.background) ? waits.background : undefined;
  const queuedDeliveries =
    lifecycle.runActive !== true &&
    background !== undefined &&
    background.length > 0 &&
    background.every((value) => {
      const source = record(value).source;
      return typeof source === "string" && source.startsWith("delivery:") && source !== "delivery:";
    });
  return (
    lifecycle.role === "root" &&
    (lifecycle.state === "running" ||
      (lifecycle.state === "waiting_background" && queuedDeliveries)) &&
    lifecycle.restoring === false &&
    lifecycle.persisted === true &&
    typeof lifecycle.runId === "string" &&
    lifecycle.activity === undefined &&
    Array.isArray(lifecycle.holds) &&
    lifecycle.holds.length === 0 &&
    waits.children === 0 &&
    background !== undefined &&
    (background.length === 0 || queuedDeliveries) &&
    Array.isArray(waits.human) &&
    waits.human.length === 0 &&
    state.isStreaming === false &&
    state.isCompacting === false &&
    state.isBashRunning === false &&
    state.retryAttempt === 0 &&
    typeof state.pendingMessageCount === "number" &&
    (state.pendingMessageCount > 0 || queuedDeliveries)
  );
}

export function omoTaskEvent(value: unknown, nativeThreadId?: string): PiRpcRecord | undefined {
  const data = record(value);
  if (!Array.isArray(data.tasks)) return undefined;
  return {
    type: "t3.native_subagents",
    ...(nativeThreadId === undefined ? {} : { nativeThreadId }),
    details: {
      results: data.tasks.flatMap((value) => {
        const task = record(value);
        if (typeof task.task_id !== "string" || typeof task.status !== "string") return [];
        const finished = ["completed", "error", "cancelled", "interrupted", "lost"].includes(
          task.status,
        );
        const status =
          task.status === "pending"
            ? "pending"
            : task.status === "paused" ||
                (task.status === "running" && task.awaiting_input !== undefined)
              ? "waiting"
              : task.status === "error" || task.status === "lost"
                ? "failed"
                : ["running", "completed", "cancelled", "interrupted"].includes(task.status)
                  ? task.status
                  : undefined;
        if (status === undefined) return [];
        const transcript = omoTaskTranscript(task.transcript);
        const output =
          task.final_response ??
          task.error_message ??
          record(task.live_progress).last_assistant_line ??
          "";
        return [
          {
            nativeTaskId:
              typeof data.parent_session_id === "string"
                ? `${data.parent_session_id}/${task.task_id}`
                : task.task_id,
            taskRef: task.task_id,
            childSessionId: task.child_session_id,
            ...(transcript === undefined ? {} : { transcript }),
            startedAt: task.created_at,
            updatedAt: task.updated_at,
            ...(finished ? { completedAt: task.updated_at } : {}),
            status,
            agent:
              task.name !== task.task_id
                ? (task.name ?? task.agent_type ?? task.category ?? "OMO task")
                : (task.agent_type ?? task.category ?? "OMO task"),
            task: task.description ?? task.task_summary ?? task.task_id,
            model:
              record(task.effective_model).display ??
              record(task.resolved_model).display ??
              task.model,
            finished,
            stopReason:
              task.status === "cancelled" || task.status === "interrupted"
                ? "aborted"
                : task.status === "error" || task.status === "lost"
                  ? "error"
                  : "stop",
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: typeof output === "string" ? output : "" }],
              },
            ],
            errorMessage: task.error_message,
          },
        ];
      }),
    },
  };
}

export class OmoTaskUpdates {
  private sessionId: string | undefined;
  private sessionFile: string | undefined;

  reset() {
    this.sessionId = undefined;
    this.sessionFile = undefined;
  }

  bind(value: unknown) {
    const state = record(value);
    this.sessionId = typeof state.sessionId === "string" ? state.sessionId : undefined;
    this.sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
  }

  observe(value: unknown): PiRpcRecord | undefined {
    if (
      this.sessionId === undefined ||
      this.sessionFile === undefined ||
      record(value).parent_session_id !== this.sessionId
    )
      return undefined;
    return omoTaskEvent(value, this.sessionFile);
  }
}

export function omoPermissionRequest(event: PiRpcRecord): PiRpcRecord | undefined {
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "select" ||
    typeof event.title !== "string" ||
    typeof event.id !== "string" ||
    !Array.isArray(event.options) ||
    !event.options.includes("Allow once") ||
    !event.options.includes("Deny")
  )
    return undefined;
  const permission = /^(?:[^\r\n]{1,256}:\s*)?Permission required:\s*([^\s\n]+)/.exec(
    event.title,
  )?.[1];
  return permission === undefined
    ? undefined
    : {
        ...event,
        method: "confirm",
        title: `Allow ${permission}?`,
        message: event.title,
      };
}

export function omoStartupFailure(value: unknown): string | undefined {
  const initialized = record(value);
  if (initialized.available === true) return undefined;
  const native = record(initialized.nativeTask);
  const cox = record(initialized.coxOrchestration);
  const unavailable = Array.isArray(cox.tools)
    ? cox.tools.flatMap((value) => {
        const tool = record(value);
        return ["active", "searchable", "excluded"].includes(String(tool.status))
          ? []
          : [`${String(tool.name)}: ${String(tool.status)}`];
      })
    : [];
  return [
    "The Cox OMO Native extension did not initialize.",
    ...(native.required === true && initialized.nativeTaskReady !== true
      ? [`Native task: ${String(native.status ?? "unavailable")}.`]
      : []),
    ...(cox.required === true && cox.connected !== true ? ["Cox MCP is not connected."] : []),
    ...(unavailable.length > 0 ? [`Cox tools: ${unavailable.join(", ")}.`] : []),
  ].join(" ");
}

export const makeOmoRpcConnection: typeof makePiRpcConnection = Effect.fn("makeOmoRpcConnection")(
  function* (options: PiRpcSpawnOptions) {
    const scope = yield* Effect.scope;
    const managed = options.env.COX_OMO_MANAGED_MODELS === "1";
    const allowed = new Set(
      yield* decodeAllowedModels(options.env.COX_OMO_ALLOWED_MODELS ?? "[]").pipe(
        Effect.mapError((cause) => new PiRpcError({ operation: "startup", cause })),
      ),
    );
    const connection = yield* makePiRpcConnection(options);
    const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
    const ephemeral = options.env.COX_OMO_EPHEMERAL === "1";
    const lifecycle = new OmoLifecycle(ephemeral);
    let selectionBaseline: PiRpcRecord = {};
    const failureRecovery = new OmoFailureRecovery();
    const taskUpdates = new OmoTaskUpdates();
    const dagUpdates = new OmoDagUpdates();
    let boundState: PiRpcRecord = {};
    let bindingGeneration = 0;
    const dagHeads = new Map<string, number>();
    const bindState = (state: unknown) => {
      const next = record(state);
      if (next.sessionId !== boundState.sessionId || next.sessionFile !== boundState.sessionFile) {
        bindingGeneration++;
        dagHeads.clear();
      }
      boundState = next;
      lifecycle.bind(state);
      taskUpdates.bind(state);
      dagUpdates.bind(state);
    };
    const refreshDags = Effect.fnUntraced(function* (ids?: ReadonlyArray<string>) {
      const state = boundState;
      const generation = bindingGeneration;
      if (typeof state.sessionId !== "string" || typeof state.sessionFile !== "string") return [];
      const runIds =
        ids ??
        omoDagRunIdsFromRpc(
          yield* connection
            .request(
              { type: "extension_request", name: "omo.dag.list", data: { limit: 256 } },
              2_000,
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
          state.sessionId,
        );
      if (runIds === undefined) return [];
      const results = yield* Effect.forEach(
        [...new Set(runIds)].slice(0, 256),
        Effect.fnUntraced(function* (runId) {
          const snapshot = omoDagSnapshotFromRpc(
            yield* connection
              .request(
                { type: "extension_request", name: "omo.dag.snapshot", data: { runId } },
                2_000,
              )
              .pipe(Effect.orElseSucceed(() => undefined)),
          );
          if (
            bindingGeneration !== generation ||
            snapshot === undefined ||
            snapshot.parentSessionId !== state.sessionId
          )
            return [];
          dagHeads.set(runId, Math.max(dagHeads.get(runId) ?? -1, Number(snapshot.lastSeq)));
          while (dagHeads.size > 256) dagHeads.delete(dagHeads.keys().next().value!);
          const event = dagUpdates.observe(snapshot);
          return event?.details.results ?? [];
        }),
        { concurrency: 4 },
      );
      return results.flat();
    });
    const taskTranscripts = new Map<
      string,
      { readonly signature: string; readonly transcript: unknown }
    >();
    const permissions = new Set<string>();
    const snapshotTasks = (sessionId: string) =>
      connection.request(
        {
          type: "extension_request",
          name: "omo.task.list",
          data: { parent_session_id: sessionId },
        },
        2_000,
      );
    const translateTasks = Effect.fnUntraced(function* (value: unknown) {
      const snapshot = record(value);
      const generation = bindingGeneration;
      const translated = taskUpdates.observe(snapshot);
      if (translated === undefined || !Array.isArray(snapshot.tasks)) return translated;
      const sessionFile = translated.nativeThreadId;
      const entries = snapshot.tasks.map(record);
      const signature = (task: PiRpcRecord) =>
        encodeTaskState([
          snapshot.parent_session_id,
          task.task_id,
          task.child_session_id,
          task.status,
          task.updated_at,
          task.live_progress,
          task.final_response,
          task.error_message,
        ]);
      const selectedTasks = entries.filter(
        (task) =>
          typeof task.task_id === "string" &&
          taskTranscripts.get(String(task.task_id))?.signature !== signature(task),
      );
      for (let offset = 0; offset < selectedTasks.length; offset += 32) {
        const selected = selectedTasks.slice(offset, offset + 32);
        const response = record(
          yield* connection
            .request(
              {
                type: "extension_request",
                name: "cox.omo.task-transcripts",
                data: {
                  nativeThreadId: sessionFile,
                  taskIds: selected.map((task) => task.task_id),
                },
              },
              2_000,
            )
            .pipe(Effect.orElseSucceed(() => undefined)),
        );
        if (bindingGeneration !== generation) return undefined;
        if (response.nativeThreadId === sessionFile && Array.isArray(response.transcripts)) {
          for (const value of response.transcripts) {
            const result = record(value);
            const task = selected.find(
              (task) =>
                task.task_id === result.taskId && task.child_session_id === result.childSessionId,
            );
            const transcript = omoTaskTranscript(result);
            if (task !== undefined && transcript !== undefined)
              taskTranscripts.set(String(task.task_id), { signature: signature(task), transcript });
          }
        }
      }
      while (taskTranscripts.size > 256)
        taskTranscripts.delete(taskTranscripts.keys().next().value!);
      return taskUpdates.observe({
        ...snapshot,
        tasks: entries.map((task) => ({
          ...task,
          transcript: taskTranscripts.get(String(task.task_id))?.transcript,
        })),
      });
    });
    const permissionReply = (input: PiRpcRecord): PiRpcRecord => {
      if (
        input.type !== "extension_ui_response" ||
        typeof input.id !== "string" ||
        !permissions.has(input.id)
      )
        return input;
      permissions.delete(input.id);
      return {
        type: "extension_ui_response",
        id: input.id,
        value: input.confirmed === true ? "Allow once" : "Deny",
      };
    };
    yield* Effect.gen(function* () {
      while (true) {
        let event = yield* Queue.take(connection.events);
        const permission = omoPermissionRequest(event);
        if (permission !== undefined) {
          permissions.add(String(permission.id));
          event = permission;
        }
        if (event.type === "extension_event" && event.name === "omo.task.updated") {
          const taskEvent = yield* translateTasks(event.data);
          if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
          continue;
        }
        if (
          event.type === "extension_event" &&
          ["omo.dag.updated", "omo.dag.event", "omo.dag.heartbeat", "omo.dag.activity"].includes(
            String(event.name),
          )
        ) {
          const data = record(event.data);
          if (data.schemaVersion !== undefined && data.schemaVersion !== 1) continue;
          if (event.name === "omo.dag.updated" && data.parent_session_id !== boundState.sessionId)
            continue;
          if (
            event.name === "omo.dag.event" &&
            typeof data.runId === "string" &&
            Number.isSafeInteger(data.seq) &&
            Number(data.seq) <= (dagHeads.get(data.runId) ?? -1)
          )
            continue;
          if (event.name === "omo.dag.activity") {
            const activity = dagUpdates.activity(data);
            if (activity !== undefined) yield* Queue.offer(events, activity);
          }
          if (
            event.name === "omo.dag.updated" ||
            event.name === "omo.dag.event" ||
            event.name === "omo.dag.heartbeat"
          ) {
            const provisional =
              event.name === "omo.dag.updated" ? dagUpdates.observe(event) : undefined;
            if (provisional !== undefined) yield* Queue.offer(events, provisional);
            const ids =
              event.name === "omo.dag.heartbeat"
                ? Array.isArray(data.runs) && data.runs.length <= 256
                  ? data.runs.flatMap((value) => {
                      const run = record(value);
                      return typeof run.runId === "string" &&
                        run.runId.length <= 256 &&
                        Number.isSafeInteger(run.headSeq) &&
                        Number(run.headSeq) > (dagHeads.get(run.runId) ?? -1)
                        ? [run.runId]
                        : [];
                    })
                  : []
                : typeof data.runId === "string" && data.runId.length <= 512
                  ? [data.runId]
                  : event.name === "omo.dag.updated" &&
                      Array.isArray(data.runs) &&
                      data.runs.length <= 256
                    ? data.runs.flatMap((value) =>
                        typeof record(value).run_id === "string"
                          ? [String(record(value).run_id)]
                          : [],
                      )
                    : undefined;
            const graphs = yield* refreshDags(ids);
            if (graphs.length > 0)
              yield* Queue.offer(events, {
                type: "t3.native_subagents",
                nativeThreadId: boundState.sessionFile,
                details: { results: graphs },
              });
          }
          continue;
        }
        const translated = lifecycle.observe(event);
        if (
          translated.some((event) => event.type === "agent_settled") &&
          options.env.COX_OMO_TOOLS_REQUIRED === "1"
        ) {
          const root = record(event.lifecycle).rootSessionId;
          if (typeof root === "string") {
            const snapshot = yield* snapshotTasks(root).pipe(Effect.orElseSucceed(() => undefined));
            const taskEvent = yield* translateTasks(snapshot);
            if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
          }
        }
        for (const item of translated) yield* Queue.offer(events, item);
        if (failureRecovery.observe(event)) {
          const generation = bindingGeneration;
          const state = record(
            yield* connection
              .request({ type: "get_state" })
              .pipe(Effect.orElseSucceed(() => undefined)),
          );
          if (
            generation === bindingGeneration &&
            (event.sessionId === undefined || state.sessionId === event.sessionId) &&
            failureRecovery.stranded(state)
          ) {
            yield* connection
              .request({ type: "clear_queue" })
              .pipe(Effect.ensuring(connection.terminate), Effect.ignore);
          }
        }
      }
    }).pipe(
      Effect.catchCause((cause) => Queue.failCause(events, cause)),
      Effect.forkIn(scope),
    );
    yield* connection.request({
      type: "set_client_info",
      capabilities: ["interactive_user", "extension_events"],
    });
    const info = record(yield* connection.request({ type: "get_protocol_info" }));
    if (!Array.isArray(info.capabilities) || !info.capabilities.includes("session_lifecycle"))
      return yield* new PiRpcError({
        operation: "startup",
        detail:
          "OMO Native requires the session_lifecycle capability. Install the supported omo-ai 5.1.69 runtime.",
      });
    if (!info.capabilities.includes("set_permission_preset_v1"))
      return yield* new PiRpcError({
        operation: "startup",
        detail:
          "OMO Native must support set_permission_preset_v1 to synchronize Cox permission modes safely.",
      });
    if (options.env.COX_OMO_EXTENSION_REQUIRED === "1") {
      const initialized = record(
        yield* connection.request({ type: "extension_request", name: "cox.omo.ready", data: {} }),
      );
      selectionBaseline = record(initialized.selectionBaseline);
      const failure = omoStartupFailure(initialized);
      if (failure !== undefined)
        return yield* new PiRpcError({
          operation: "startup",
          detail: failure,
        });
    }
    if (options.env.COX_OMO_MANAGED_MODELS === "1")
      yield* connection.request({ type: "set_auto_retry", enabled: false });
    return {
      ...connection,
      events,
      send: (input: PiRpcRecord) => connection.send(permissionReply(input)),
      request: Effect.fn("OmoRpc.request")(function* (input: PiRpcRecord, timeoutMs?: number) {
        if (
          managed &&
          input.type === "set_model" &&
          !allowed.has(`${String(input.provider)}/${String(input.modelId)}`)
        )
          return yield* new PiRpcError({
            operation: "set_model",
            detail: "The requested model is outside this Cox model service binding.",
          });
        if (["new_session", "switch_session", "fork"].includes(String(input.type))) {
          lifecycle.reset();
          failureRecovery.reset();
          taskUpdates.reset();
          dagUpdates.reset();
          bindingGeneration++;
          dagHeads.clear();
          boundState = {};
          selectionBaseline = {};
          taskTranscripts.clear();
        }
        if (input.type === "extension_request" && input.name === "cox.omo.tasks") {
          const state = record(yield* connection.request({ type: "get_state" }, timeoutMs));
          bindState(state);
          if (
            typeof state.sessionId !== "string" ||
            record(input.data).nativeThreadId !== state.sessionFile
          )
            return undefined;
          const tasks = yield* translateTasks(yield* snapshotTasks(state.sessionId));
          yield* refreshDags();
          const graphs = dagUpdates.snapshot()?.details.results ?? [];
          const details = record(tasks?.details);
          return {
            type: "t3.native_subagents",
            nativeThreadId: state.sessionFile,
            details: {
              results: [...(Array.isArray(details.results) ? details.results : []), ...graphs],
            },
          };
        }
        const response = yield* connection.request(
          input.type === "abort"
            ? { ...input, intent: "stop", awaitIdle: true, clearQueue: true, graceMs: 2_000 }
            : input.type === "set_model" &&
                Array.isArray(info.capabilities) &&
                info.capabilities.includes("session_model_scope")
              ? { ...input, scope: "session" }
              : input,
          timeoutMs,
        );
        if (
          ["new_session", "switch_session", "fork"].includes(String(input.type)) &&
          options.env.COX_OMO_EXTENSION_REQUIRED === "1"
        ) {
          const initialized = record(
            yield* connection.request({
              type: "extension_request",
              name: "cox.omo.ready",
              data: {},
            }),
          );
          selectionBaseline = record(initialized.selectionBaseline);
        }
        if (input.type === "abort") {
          const stopped = yield* Effect.gen(function* () {
            if (record(response).stopped !== true) return false;
            if (options.env.COX_OMO_TOOLS_REQUIRED === "1") {
              const state = record(yield* connection.request({ type: "get_state" }, 2_000));
              const root = record(state.lifecycle).rootSessionId;
              if (typeof root !== "string") return false;
              const snapshot = record(yield* snapshotTasks(root));
              if (!Array.isArray(snapshot.tasks)) return false;
              yield* Effect.forEach(
                snapshot.tasks.filter((value) => !omoTaskIsQuiescent(value)),
                (value) =>
                  connection.request(
                    {
                      type: "extension_request",
                      name: "omo.task.cancel",
                      data: { task_id: record(value).task_id, reason: "Stopped in Cox." },
                    },
                    5_000,
                  ),
                { concurrency: 4, discard: true },
              );
              const final = record(yield* snapshotTasks(root));
              const taskEvent = yield* translateTasks(final);
              if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
              if (
                !Array.isArray(final.tasks) ||
                final.tasks.some((value) => !omoTaskIsQuiescent(value))
              )
                return false;
            }
            return true;
          }).pipe(Effect.orElseSucceed(() => false));
          if (stopped) yield* Queue.offer(events, { type: "agent_settled", aborted: true });
          else yield* connection.terminate;
        }
        if (managed && input.type === "get_available_models") {
          const inventory = record(response);
          return {
            ...inventory,
            models: Array.isArray(inventory.models)
              ? inventory.models.filter((value) => {
                  const model = record(value);
                  return allowed.has(`${String(model.provider)}/${String(model.id)}`);
                })
              : [],
          };
        }
        if (input.type !== "get_state") return response;
        bindState(response);
        return yield* Effect.try({
          try: () =>
            omoSessionState(
              {
                ...record(response),
                coxBaselineModel: selectionBaseline.model,
                coxBaselineThinking: selectionBaseline.thinkingLevel,
              },
              ephemeral,
            ),
          catch: (cause) => new PiRpcError({ operation: "get_state", cause }),
        });
      }),
    };
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause._tag === "PiRpcTimeoutError"
          ? new PiRpcError({ operation: "startup", cause })
          : cause,
      ),
    ),
);
