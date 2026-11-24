import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitResult,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadStatus,
  type OrchestratorMcpThreadTimelineItem,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { mcpToolSession, type McpToolSession } from "../mcp/AcpMcpStdioBridge.ts";
import { expandHomePath } from "../os-jank.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

/**
 * Short enough that a run which stops to ask the user something is noticed
 * soon, since `cox_thread_wait` only returns on a terminal run.
 */
const WAIT_SLICE_MS = 15_000;
const READ_PAGE_LIMIT = 100;
const TITLE_MAX_CHARS = 80;

export class ThreadServerNotRunningError extends Schema.TaggedError<ThreadServerNotRunningError>()(
  "ThreadServerNotRunningError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No running Cox server uses ${this.baseDir}. Start Cox, then retry.`;
  }
}

export class ThreadServerUnreachableError extends Schema.TaggedError<ThreadServerUnreachableError>()(
  "ThreadServerUnreachableError",
  { origin: Schema.String, cause: Schema.Defect() },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.cause instanceof Error ? ` ${this.cause.message}` : "";
    return `Could not reach the Cox server at ${this.origin}.${reason}`;
  }
}

export class ThreadToolFailedError extends Schema.TaggedError<ThreadToolFailedError>()(
  "ThreadToolFailedError",
  { tool: Schema.String, detail: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadUsageError extends Schema.TaggedError<ThreadUsageError>()("ThreadUsageError", {
  detail: Schema.String,
}) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return this.detail;
  }
}

export class ThreadProjectNotFoundError extends Schema.TaggedError<ThreadProjectNotFoundError>()(
  "ThreadProjectNotFoundError",
  { identifier: Schema.String },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    return `No Cox project matches '${this.identifier}'. Pass a project id or a path inside a project.`;
  }
}

/** Exit code 2 lets a script tell "needs a human" apart from a failed run. */
export class ThreadNeedsInputError extends Schema.TaggedError<ThreadNeedsInputError>()(
  "ThreadNeedsInputError",
  { threadId: ThreadId },
) {
  override readonly [Runtime.errorReported] = false;
  override readonly [Runtime.errorExitCode] = 2;

  override get message(): string {
    return `Thread ${this.threadId} is waiting for an answer. Open it in Cox to respond.`;
  }
}

export class ThreadRunEndedError extends Schema.TaggedError<ThreadRunEndedError>()(
  "ThreadRunEndedError",
  { threadId: ThreadId, status: Schema.String, error: Schema.optional(Schema.String) },
) {
  override readonly [Runtime.errorReported] = false;
  override get message(): string {
    const reason = this.error === undefined ? "." : `: ${this.error}`;
    return `Thread ${this.threadId} stopped with status ${this.status}${reason}`;
  }
}

const ThreadCliError = Schema.Union([
  ThreadServerNotRunningError,
  ThreadServerUnreachableError,
  ThreadToolFailedError,
  ThreadUsageError,
  ThreadProjectNotFoundError,
  ThreadNeedsInputError,
  ThreadRunEndedError,
]);
const isThreadCliError = Schema.is(ThreadCliError);

/**
 * These errors are expected outcomes for a script, so they print as one line
 * on stderr instead of the runtime's logged stack trace.
 */
export const reportThreadErrors = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      isThreadCliError(error) ? Console.error(error.message) : Effect.void,
    ),
  );

const decodeFailureText = Schema.decodeUnknownOption(Schema.fromJsonString(OrchestratorMcpFailure));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const printJson = (value: unknown) => Console.log(encodeJson(value));

const ToolResult = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
});

const decodeToolResult = Schema.decodeUnknownEffect(ToolResult);

const ProjectListResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({ id: ProjectId, title: Schema.String, workspaceRoot: Schema.String }),
  ),
  nextCursor: Schema.NullOr(Schema.Int),
});

const ThreadLaunchResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  runId: Schema.NullOr(RunId),
});

const toolFailureDetail = (result: typeof ToolResult.Type) => {
  const text = result.content?.find((part) => part.text !== undefined)?.text ?? "";
  return Option.match(decodeFailureText(text), {
    onNone: () => text || "The tool call failed.",
    onSome: (failure) => failure.message,
  });
};

const makeThreadTools = (session: McpToolSession, origin: string) => {
  const unexpected = (tool: string) =>
    new ThreadToolFailedError({
      tool,
      detail: `The server sent an unexpected ${tool} result. Update the t3 CLI to match the server.`,
    });
  return {
    call: Effect.fn("cli.thread.callTool")(function* <S extends Schema.Decoder<unknown>>(
      tool: string,
      args: Readonly<Record<string, unknown>>,
      schema: S,
    ): Effect.fn.Return<S["Type"], ThreadServerUnreachableError | ThreadToolFailedError> {
      const raw = yield* session.call(tool, args).pipe(
        Effect.mapError((cause) => {
          if (cause.rpcError === undefined)
            return new ThreadServerUnreachableError({ origin, cause });
          const message = cause.rpcError.message.replaceAll(/\s*\n\s*/g, " ");
          const detail =
            cause.rpcError.code === -32602
              ? `The server refused the arguments: ${message}`
              : `The server refused the request: ${message}`;
          return new ThreadToolFailedError({ tool, detail });
        }),
      );
      const result = yield* decodeToolResult(raw).pipe(Effect.mapError(() => unexpected(tool)));
      if (result.isError === true) {
        return yield* new ThreadToolFailedError({ tool, detail: toolFailureDetail(result) });
      }
      return yield* Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
        Effect.mapError(() => unexpected(tool)),
      );
    }),
  };
};
export type ThreadTools = ReturnType<typeof makeThreadTools>;

/**
 * Signs in as a short-lived MCP client of the running server, the same way an
 * outside agent does, and revokes that session when the command ends.
 */
export const withThreadTools = Effect.fn("cli.thread.withThreadTools")(function* <A, E, R>(
  flags: { readonly baseDir: Option.Option<string>; readonly json: boolean },
  run: (tools: ThreadTools) => Effect.Effect<A, E, R>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, { quietLogs: flags.json });
  const minimumLogLevel = flags.json ? "Error" : config.logLevel;
  return yield* Effect.gen(function* () {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return yield* new ThreadServerNotRunningError({ baseDir: config.baseDir });
    }
    const origin = runtimeState.value.origin;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const issued = yield* Effect.acquireRelease(
      environmentAuth.issueMcpClientSession({
        label: "t3 thread cli",
        // The CLI runs as the machine's owner. New threads still start at
        // the project's default mode, never at this ceiling by default.
        access: "full-access",
        client: { deviceType: "bot" },
      }),
      (session) =>
        environmentAuth.revokeSession(session.sessionId).pipe(Effect.ignore({ log: true })),
    );
    const session = yield* mcpToolSession({
      endpoint: new URL("/mcp", origin).href,
      authorization: `Bearer ${issued.token}`,
      clientName: "t3-thread-cli",
    }).pipe(Effect.mapError((cause) => new ThreadServerUnreachableError({ origin, cause })));
    return yield* run(makeThreadTools(session, origin));
  }).pipe(
    Effect.scoped,
    Effect.provideService(References.MinimumLogLevel, minimumLogLevel),
    Effect.provide(
      EnvironmentAuth.layerRuntime.pipe(
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const readMessageArgument = Effect.fn("cli.thread.readMessage")(function* (argument: string) {
  const text =
    argument === "-"
      ? yield* Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)),
        )
      : argument;
  if (text.trim().length === 0) {
    return yield* new ThreadUsageError({ detail: "The message is empty." });
  }
  return text;
});

const listAllProjects = Effect.fn("cli.thread.listAllProjects")(function* (tools: ThreadTools) {
  const projects: Array<(typeof ProjectListResult.Type)["projects"][number]> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: typeof ProjectListResult.Type = yield* tools.call(
      "cox_project_list",
      { cursor, limit: 100 },
      ProjectListResult,
    );
    projects.push(...page.projects);
    cursor = page.nextCursor;
  }
  return projects;
});

/** A project id, or a path inside a project's folder (deepest project wins). */
const resolveProject = Effect.fn("cli.thread.resolveProject")(function* (
  tools: ThreadTools,
  identifier: string,
) {
  const projects = yield* listAllProjects(tools);
  const byId = projects.find((project) => project.id === identifier);
  if (byId !== undefined) return byId;

  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  // Stored roots keep the path the project was added with, which may pass
  // through a symlink (macOS /tmp), so both sides compare as real paths.
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => value));
  const target = yield* realPath(
    path.resolve(yield* HostProcess.WorkingDirectory, yield* expandHomePath(identifier)),
  );
  const roots = yield* Effect.forEach(projects, (project) =>
    Effect.map(realPath(project.workspaceRoot), (root) => ({ project, root })),
  );
  const containing = roots
    .filter(({ root }) => {
      const relative = path.relative(root, target);
      return (
        relative === "" ||
        (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      );
    })
    .toSorted((left, right) => right.root.length - left.root.length)[0];
  if (containing === undefined) {
    return yield* new ThreadProjectNotFoundError({ identifier });
  }
  return containing.project;
});

/** Every item on a timeline view, oldest first. */
const readTimeline = Effect.fn("cli.thread.readTimeline")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  view: "messages" | "activity",
) {
  const items: Array<OrchestratorMcpThreadTimelineItem> = [];
  let afterPosition: number | undefined;
  let page: OrchestratorMcpThreadReadResult;
  do {
    page = yield* tools.call(
      "cox_thread_read",
      {
        threadId,
        view,
        limit: READ_PAGE_LIMIT,
        runLimit: 1,
        ...(afterPosition === undefined ? {} : { afterPosition }),
      },
      OrchestratorMcpThreadReadResult,
    );
    items.push(...page.items);
    afterPosition = page.nextPosition ?? undefined;
  } while (page.hasMore && afterPosition !== undefined);
  return { thread: page.thread, items };
});

/**
 * The latest `count` user and assistant messages, oldest first. Positions
 * count every timeline item, so the read starts near the end and widens
 * backward only while tool and plan items leave too few messages.
 */
export const readLatestMessages = Effect.fn("cli.thread.readLatestMessages")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  count: number,
) {
  let { thread } = yield* tools.call(
    "cox_thread_read",
    { threadId, limit: 1, runLimit: 1 },
    OrchestratorMcpThreadReadResult,
  );
  let messages: Array<OrchestratorMcpThreadTimelineItem> = [];
  // The newest window has no upper bound, so items added since the first
  // read are still shown.
  let before: number | undefined;
  let start = thread.itemCount;
  let span = Math.max(count, READ_PAGE_LIMIT);
  do {
    const end = before;
    start = Math.max(0, start - span);
    const window: Array<OrchestratorMcpThreadTimelineItem> = [];
    let afterPosition = start - 1;
    let page: OrchestratorMcpThreadReadResult;
    do {
      page = yield* tools.call(
        "cox_thread_read",
        {
          threadId,
          view: "messages",
          limit: READ_PAGE_LIMIT,
          runLimit: 1,
          ...(afterPosition < 0 ? {} : { afterPosition }),
        },
        OrchestratorMcpThreadReadResult,
      );
      window.push(
        ...page.items.filter(
          (item) =>
            (item.type === "user_message" || item.type === "assistant_message") &&
            (end === undefined || item.position < end),
        ),
      );
      afterPosition = page.nextPosition ?? Number.POSITIVE_INFINITY;
    } while (page.hasMore && afterPosition < (end ?? Number.POSITIVE_INFINITY) - 1);
    // Only the first read carries pull request previews; later pages omit them.
    thread = Object.assign({}, thread, page.thread);
    // A window can hold the whole --messages count, too many to spread as arguments.
    messages = window.concat(messages);
    before = start;
    span *= 2;
  } while (messages.length < count && start > 0);
  return { thread, messages: messages.slice(Math.max(0, messages.length - count)) };
});

/** Item text past the read's per-item cap. */
const readFullText = Effect.fn("cli.thread.readFullText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  item: OrchestratorMcpThreadTimelineItem,
) {
  let text = item.text ?? "";
  let nextTextOffset = item.textTruncated ? (item.nextTextOffset ?? null) : null;
  while (nextTextOffset !== null) {
    const page = yield* tools.call(
      "cox_thread_read",
      { threadId, itemId: item.itemId, textOffset: nextTextOffset, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    const chunk = page.items.find((candidate) => candidate.itemId === item.itemId);
    if (chunk === undefined) break;
    text += chunk.text ?? "";
    nextTextOffset = chunk.textTruncated ? (chunk.nextTextOffset ?? null) : null;
  }
  return text;
});

/** The run's last assistant message, or its last error when it did not complete. */
const runResultText = Effect.fn("cli.thread.runResultText")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
  type: "assistant_message" | "error",
) {
  const { items } = yield* readTimeline(
    tools,
    threadId,
    type === "assistant_message" ? "messages" : "activity",
  );
  const item = items.findLast((candidate) => candidate.runId === runId && candidate.type === type);
  return item === undefined ? null : yield* readFullText(tools, threadId, item);
});

/** The latest run's last error once it ended without completing, else null. */
export const latestRunError = Effect.fn("cli.thread.latestRunError")(function* (
  tools: ThreadTools,
  thread: Pick<OrchestratorMcpThreadDetail, "threadId" | "status" | "latestRunId">,
) {
  const { status, latestRunId } = thread;
  if (
    latestRunId === null ||
    (status !== "failed" &&
      status !== "cancelled" &&
      status !== "interrupted" &&
      status !== "rolled_back")
  )
    return null;
  return yield* runResultText(tools, thread.threadId, latestRunId, "error");
});

type WaitOutcome =
  | {
      readonly type: "ended";
      readonly runId: RunId | null;
      readonly status: OrchestratorMcpThreadStatus;
      readonly output?: Schema.Json;
    }
  | { readonly type: "needs_input" };

/**
 * Waits for this exact run, following a restart to its continuation, so a
 * message another client sends meanwhile cannot stand in for its result.
 */
export const waitForRun = Effect.fn("cli.thread.waitForRun")(function* (
  tools: ThreadTools,
  threadId: ThreadId,
  runId: RunId,
  untilOutput = false,
) {
  const waitSlice = (timeoutMs: number) =>
    tools.call(
      "cox_thread_wait",
      { threadId, runId, timeoutMs, ...(untilOutput ? { untilOutput: true } : {}) },
      OrchestratorMcpThreadWaitResult,
    );
  const ended = (waited: OrchestratorMcpThreadWaitResult) =>
    ({
      type: "ended",
      runId: waited.runId,
      status: waited.status,
      ...(waited.output === undefined ? {} : { output: waited.output }),
    }) satisfies WaitOutcome;
  while (true) {
    const waited = yield* waitSlice(WAIT_SLICE_MS);
    if (!waited.timedOut) return ended(waited);
    // A pending request on this run, or on an earlier run this one is queued
    // behind, blocks it until someone answers.
    const { thread } = yield* tools.call(
      "cox_thread_read",
      { threadId, limit: 1, runLimit: 1 },
      OrchestratorMcpThreadReadResult,
    );
    if (thread.pendingRequestCount > 0) {
      // The count is thread-wide: if this run ended since the slice, the
      // request belongs to a later run.
      const recheck = yield* waitSlice(1);
      return recheck.timedOut ? ({ type: "needs_input" } satisfies WaitOutcome) : ended(recheck);
    }
  }
});

/**
 * With --json the result always reaches stdout, so a script keeps the thread
 * id even when the run fails.
 */
const finishRun = Effect.fn("cli.thread.finishRun")(function* (
  tools: ThreadTools,
  input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly json: boolean;
    readonly untilOutput?: boolean;
  },
) {
  const outcome = yield* waitForRun(tools, input.threadId, input.runId, input.untilOutput);
  const runId = outcome.type === "ended" ? (outcome.runId ?? input.runId) : input.runId;
  const status = outcome.type === "ended" ? outcome.status : "waiting";
  const reply =
    status === "completed"
      ? yield* runResultText(tools, input.threadId, runId, "assistant_message")
      : null;
  const error =
    status === "completed" || status === "waiting"
      ? null
      : yield* runResultText(tools, input.threadId, runId, "error");
  if (input.json) {
    const output = outcome.type === "ended" ? outcome.output : undefined;
    yield* printJson({
      threadId: input.threadId,
      runId,
      status,
      reply,
      error,
      ...(output === undefined ? {} : { output }),
    });
  } else if (reply !== null) {
    yield* Console.log(reply);
  }
  if (outcome.type === "needs_input") {
    return yield* new ThreadNeedsInputError({ threadId: input.threadId });
  }
  if (status !== "completed") {
    return yield* new ThreadRunEndedError({
      threadId: input.threadId,
      status,
      ...(error === null ? {} : { error }),
    });
  }
});

const titleFromMessage = (message: string) => {
  const firstLine = message.trim().split("\n")[0]?.trim() ?? "";
  return firstLine.length > TITLE_MAX_CHARS
    ? `${firstLine.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`
    : firstLine;
};

const launchWorkspaceStrategy = (input: {
  readonly worktree: Option.Option<string>;
  readonly branch: Option.Option<string>;
}) =>
  Option.match(input.worktree, {
    onNone: () =>
      Option.isSome(input.branch)
        ? Effect.fail(new ThreadUsageError({ detail: "--branch needs --worktree <base-ref>." }))
        : Effect.void,
    onSome: (baseRef) =>
      Effect.succeed({
        type: "worktree" as const,
        baseRef,
        ...Option.match(input.branch, { onNone: () => ({}), onSome: (branch) => ({ branch }) }),
      }),
  });

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Print JSON instead of text."),
  Flag.withDefault(false),
);
const waitFlag = Flag.Boolean("wait").pipe(
  Flag.withDescription(
    "Wait for the agent to finish and print its reply. Exits 1 if the run fails and 2 if it waits for an answer.",
  ),
  Flag.withDefault(false),
);
const outputSchemaFlag = Flag.String("output-schema").pipe(
  Flag.withDescription(
    "File holding a JSON Schema. The agent must return data matching it; --wait --json prints it as `output`.",
  ),
  Flag.optional,
);
const decodeOutputSchema = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json)),
);
export const readOutputSchema = Effect.fn("cli.thread.readOutputSchema")(function* (
  path: Option.Option<string>,
) {
  if (Option.isNone(path)) return {};
  const fileSystem = yield* FileSystem.FileSystem;
  const usage = () =>
    new ThreadUsageError({ detail: `${path.value} does not hold a JSON Schema object.` });
  const text = yield* fileSystem
    .readFileString(yield* expandHomePath(path.value))
    .pipe(Effect.mapError(usage));
  return { outputSchema: yield* decodeOutputSchema(text).pipe(Effect.mapError(usage)) };
});
const messageArgument = Argument.String("message").pipe(
  Argument.withDescription("Message for the agent, or - to read it from stdin."),
);
const threadArgument = Argument.String("thread").pipe(Argument.withDescription("Thread id."));

const decodeThreadIdValue = Schema.decodeUnknownEffect(ThreadId);
const decodeTitle = Schema.decodeUnknownEffect(TrimmedNonEmptyString);
const decodeThreadId = (value: string) =>
  decodeThreadIdValue(value.trim()).pipe(
    Effect.mapError(() => new ThreadUsageError({ detail: `'${value}' is not a thread id.` })),
  );

export const listProjectThreads = Effect.fn("cli.thread.listProjectThreads")(function* (
  tools: ThreadTools,
  projectId: ProjectId,
) {
  const threads: Array<OrchestratorMcpThreadListItem> = [];
  let cursor: number | null = 0;
  while (cursor !== null) {
    const page: OrchestratorMcpThreadListResult = yield* tools.call(
      "cox_thread_list",
      { projectId: projectId, includeSubagents: true, limit: 100, cursor },
      OrchestratorMcpThreadListResult,
    );
    threads.push(...page.threads.filter((thread) => thread.relationshipToParent !== "subagent"));
    cursor = page.nextCursor;
  }
  return threads;
});

const threadListCommand = Command.make("list", {
  ...projectLocationFlags,
  project: Flag.String("project").pipe(
    Flag.withDescription("Project id or a path inside the project. Defaults to this directory."),
    Flag.withDefault("."),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("List a project's threads, newest first."),
  Command.withHandler((flags) =>
    withThreadTools(
      flags,
      Effect.fn("cli.thread.list")(function* (tools) {
        const project = yield* resolveProject(tools, flags.project);
        const threads = yield* listProjectThreads(tools, project.id);
        if (flags.json) {
          return yield* printJson(threads);
        }
        for (const thread of threads) {
          yield* Console.log(`${thread.threadId}  ${thread.status.padEnd(11)}  ${thread.title}`);
        }
      }),
    ).pipe(reportThreadErrors),
  ),
);

const threadStartCommand = Command.make("start", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or a path inside the project, such as ."),
  ),
  message: messageArgument,
  title: Flag.String("title").pipe(
    Flag.withDescription("Thread title. Defaults to the message's first line."),
    Flag.optional,
  ),
  generateTitle: Flag.Boolean("generate-title").pipe(
    Flag.withDescription(
      "Generate the thread's title from the message. Until it's ready, the thread shows --title or the first line.",
    ),
    Flag.withDefault(false),
  ),
  provider: Flag.String("provider").pipe(
    Flag.withDescription("Provider instance id. Pass with --model."),
    Flag.optional,
  ),
  model: Flag.String("model").pipe(
    Flag.withDescription("Model slug. Defaults to the project's default model."),
    Flag.optional,
  ),
  worktree: Flag.String("worktree").pipe(
    Flag.withDescription(
      "Run in a new git worktree based on this branch, tag, or commit, instead of the project folder.",
    ),
    Flag.optional,
  ),
  branch: Flag.String("branch").pipe(
    Flag.withDescription("Branch name for the new worktree."),
    Flag.optional,
  ),
  outputSchema: outputSchemaFlag,
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start a thread in a project and print its id."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const message = yield* readMessageArgument(flags.message);
      const output = yield* readOutputSchema(flags.outputSchema);
      const workspaceStrategy = yield* launchWorkspaceStrategy(flags);
      if (Option.isSome(flags.provider) !== Option.isSome(flags.model)) {
        return yield* new ThreadUsageError({ detail: "--provider and --model go together." });
      }
      const title = yield* decodeTitle(
        Option.getOrElse(flags.title, () => titleFromMessage(message)),
      ).pipe(Effect.mapError(() => new ThreadUsageError({ detail: "The title is empty." })));
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.start")(function* (tools) {
          const project = yield* resolveProject(tools, flags.project);
          const launched = yield* tools.call(
            "cox_thread_launch",
            {
              projectId: project.id,
              title,
              ...(flags.generateTitle ? { generateTitle: true } : {}),
              message,
              ...output,
              ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
              ...(Option.isSome(flags.provider) && Option.isSome(flags.model)
                ? {
                    modelSelection: {
                      instanceId: flags.provider.value,
                      model: flags.model.value,
                    },
                  }
                : {}),
            },
            ThreadLaunchResult,
          );
          if (flags.wait && launched.runId !== null) {
            if (!flags.json) yield* Console.error(`Thread ${launched.threadId}`);
            return yield* finishRun(tools, {
              threadId: launched.threadId,
              runId: launched.runId,
              json: flags.json,
              untilOutput: Option.isSome(flags.outputSchema),
            });
          }
          yield* flags.json ? printJson(launched) : Console.log(launched.threadId);
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadSendCommand = Command.make("send", {
  ...projectLocationFlags,
  thread: threadArgument,
  message: messageArgument,
  outputSchema: outputSchemaFlag,
  wait: waitFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Send a message to a thread. A busy thread gets it as its next turn; nothing is interrupted.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      const message = yield* readMessageArgument(flags.message);
      const output = yield* readOutputSchema(flags.outputSchema);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.send")(function* (tools) {
          const sent = yield* tools.call(
            "cox_thread_send",
            { threadId, message, mode: "queue", ...output },
            OrchestratorMcpThreadSendResult,
          );
          if (flags.wait) {
            return yield* finishRun(tools, {
              threadId,
              runId: sent.runId,
              json: flags.json,
              untilOutput: Option.isSome(flags.outputSchema),
            });
          }
          yield* flags.json
            ? printJson(sent)
            : Console.log(sent.delivery === "queued" ? "Queued." : "Sent.");
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

const threadShowCommand = Command.make("show", {
  ...projectLocationFlags,
  thread: threadArgument,
  messages: Flag.Int("messages").pipe(
    Flag.withDescription("How many of the latest messages to print."),
    Flag.withDefault(10),
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show a thread's state and its latest messages."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const threadId = yield* decodeThreadId(flags.thread);
      yield* withThreadTools(
        flags,
        Effect.fn("cli.thread.show")(function* (tools) {
          const { thread, messages: latest } = yield* readLatestMessages(
            tools,
            threadId,
            flags.messages,
          );
          const messages = yield* Effect.forEach(latest, (item) =>
            readFullText(tools, threadId, item).pipe(
              Effect.map((text) => ({
                role:
                  item.type === "assistant_message"
                    ? "assistant"
                    : item.createdBy === "system"
                      ? "system"
                      : "user",
                runId: item.runId,
                text,
              })),
            ),
          );
          const error = yield* latestRunError(tools, thread);
          if (flags.json) {
            return yield* printJson({ thread, messages, error });
          }
          yield* Console.log(thread.title);
          yield* Console.log(
            [thread.threadId, thread.status, `${thread.providerInstanceId}/${thread.model}`].join(
              "  ",
            ),
          );
          if (thread.worktreePath !== null) {
            yield* Console.log(`${thread.branch ?? "(no branch)"}  ${thread.worktreePath}`);
          }
          if (thread.pendingRequestCount > 0) {
            yield* Console.log(`Waiting for ${thread.pendingRequestCount} answer(s).`);
          }
          if (error !== null) {
            yield* Console.log(`Error: ${error}`);
          }
          for (const entry of messages) {
            yield* Console.log(`\n[${entry.role}]\n${entry.text}`);
          }
        }),
      );
    }).pipe(reportThreadErrors),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Start, message, and read threads on the running server."),
  Command.withSubcommands([
    threadListCommand,
    threadStartCommand,
    threadSendCommand,
    threadShowCommand,
  ]),
);
