import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import {
  makePiRpcConnection,
  PiRpcError,
  type PiRpcRecord,
  type PiRpcSpawnOptions,
} from "@t3tools/provider-pi/server";

const terminalStates = new Set(["done", "failed", "cancelled"]);
const decodeAllowedModels = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

export class OmoLifecycle {
  private readonly ephemeral: boolean;

  constructor(ephemeral = false) {
    this.ephemeral = ephemeral;
  }
  private sessionId: string | undefined;
  private sequence = -1;
  private runId: string | undefined;
  private readonly completions = new Set<string>();

  reset() {
    this.sessionId = undefined;
    this.sequence = -1;
    this.runId = undefined;
    this.completions.clear();
  }

  observe(event: PiRpcRecord): ReadonlyArray<PiRpcRecord> {
    if (event.type === "agent_start") {
      this.runId = typeof event.runId === "string" ? event.runId : undefined;
      return [event];
    }
    if (event.type === "agent_settled" || event.type === "agent_idle") return [];
    if (event.type !== "session_lifecycle") return [event];
    const lifecycle = record(event.lifecycle);
    if (lifecycle.role === "child") return [];
    if (typeof lifecycle.seq !== "number" || typeof lifecycle.state !== "string") return [];
    const sessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
    if (this.sessionId !== undefined && sessionId !== undefined && sessionId !== this.sessionId)
      return [];
    if (sessionId !== undefined) this.sessionId = sessionId;
    if (lifecycle.seq <= this.sequence) return [];
    this.sequence = lifecycle.seq;
    if (!terminalStates.has(lifecycle.state)) return [];
    if (lifecycle.restoring === true || (lifecycle.persisted !== true && !this.ephemeral))
      return [];
    if (
      this.runId !== undefined &&
      typeof lifecycle.runId === "string" &&
      lifecycle.runId !== this.runId
    )
      return [];
    const completionId = lifecycle.completionId;
    if (typeof completionId !== "string" || this.completions.has(completionId)) return [];
    this.completions.add(completionId);
    if (this.completions.size > 128)
      this.completions.delete(this.completions.values().next().value!);
    return [
      ...(lifecycle.state === "failed"
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
  return terminalStates.has(lifecycle.state) &&
    lifecycle.restoring !== true &&
    (lifecycle.persisted === true || ephemeral || lifecycle.epoch === 0)
    ? state
    : { ...state, isStreaming: true };
}

export function omoTaskEvent(value: unknown): PiRpcRecord | undefined {
  const data = record(value);
  if (!Array.isArray(data.tasks)) return undefined;
  return {
    type: "t3.native_subagents",
    details: {
      results: data.tasks.flatMap((value) => {
        const task = record(value);
        if (typeof task.task_id !== "string" || typeof task.status !== "string") return [];
        const finished = ["completed", "error", "cancelled", "interrupted", "lost"].includes(
          task.status,
        );
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
            startedAt: task.created_at,
            agent:
              task.name !== task.task_id
                ? (task.name ?? task.agent_type ?? task.category ?? "OMO task")
                : (task.agent_type ?? task.category ?? "OMO task"),
            task: task.description ?? task.task_summary ?? task.task_id,
            model: task.model,
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
  const permission = /^(?:st_[A-Za-z0-9_-]+:\s*)?Permission required:\s*([^\s\n]+)/.exec(
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
          const taskEvent = omoTaskEvent(event.data);
          if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
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
            const taskEvent = omoTaskEvent(snapshot);
            if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
          }
        }
        for (const item of translated) yield* Queue.offer(events, item);
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
          "OMO Native requires the session_lifecycle capability. Install omo-ai 5.1.69 or newer.",
      });
    if (options.env.COX_OMO_EXTENSION_REQUIRED === "1") {
      const initialized = record(
        yield* connection.request({ type: "extension_request", name: "cox.omo.ready", data: {} }),
      );
      if (initialized.ready !== true)
        return yield* new PiRpcError({
          operation: "startup",
          detail: "The Cox OMO Native extension did not initialize.",
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
        if (["new_session", "switch_session"].includes(String(input.type))) lifecycle.reset();
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
                snapshot.tasks.filter(
                  (value) =>
                    !["completed", "error", "cancelled", "interrupted", "lost"].includes(
                      String(record(value).status),
                    ),
                ),
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
              const taskEvent = omoTaskEvent(final);
              if (taskEvent !== undefined) yield* Queue.offer(events, taskEvent);
              if (
                !Array.isArray(final.tasks) ||
                final.tasks.some((value) =>
                  ["running", "pending", "paused"].includes(String(record(value).status)),
                )
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
        return yield* Effect.try({
          try: () => omoSessionState(response, ephemeral),
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
