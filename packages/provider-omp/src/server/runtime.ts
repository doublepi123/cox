import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import {
  makePiRpcConnection,
  PiRpcError,
  PiRpcTimeoutError,
  type PiRpcConnection,
  type PiRpcRecord,
  type PiRpcSpawnOptions,
} from "@t3tools/provider-pi/server";
import { OmpFrameDecoder, OmpPromptFrames, ompRecord } from "./framing.ts";
import { OmpSubagents } from "./subagents.ts";
import { OmpTodoUpdates } from "./todo.ts";
import { ompForkBeforeEntry } from "./session.ts";

export const makeOmpRpcConnection: typeof makePiRpcConnection = Effect.fn("makeOmpRpcConnection")(
  function* (options: PiRpcSpawnOptions) {
    const scope = yield* Effect.scope;
    const decoder = new OmpFrameDecoder();
    const connection = yield* makePiRpcConnection({
      ...options,
      decodeIncomingRecord: (record) => decoder.incoming(record, options.decodeIncomingRecord),
    });
    const events = yield* Queue.unbounded<PiRpcRecord, PiRpcError>();
    const ready = yield* Deferred.make<void, PiRpcError>();
    const agents = new OmpSubagents();
    const todos = new OmpTodoUpdates();
    const prompts = new OmpPromptFrames();
    let stopped = false;
    const reset = () => {
      todos.reset();
      agents.reset();
      prompts.reset();
      stopped = false;
    };
    const bind = (
      value: unknown,
    ): PiRpcRecord & { readonly generation: string; readonly revision: number } => {
      const next = ompRecord(value);
      if (!todos.matches(next)) reset();
      return todos.bind(next);
    };
    const refreshTodos = Effect.fnUntraced(function* () {
      const epoch = todos.generation;
      const result = yield* connection.request({ type: "get_state" });
      if (epoch !== todos.generation) return;
      const snapshot = bind(result);
      yield* Queue.offer(events, {
        type: "extension_event",
        name: "cox.omp.todo.updated",
        data: snapshot,
      });
    });
    const prompt = Effect.fnUntraced(function* (
      record: PiRpcRecord,
      deferred?: Deferred.Deferred<unknown, PiRpcError>,
    ) {
      const id = prompts.begin(record, deferred);
      stopped = false;
      yield* connection
        .send({ ...record, id })
        .pipe(Effect.tapError(() => Effect.sync(() => prompts.remove(id))));
      return id;
    });
    const request: PiRpcConnection["request"] = Effect.fnUntraced(function* (
      record,
      timeoutMs = 30_000,
    ) {
      switch (record.type) {
        case "prompt": {
          const deferred = yield* Deferred.make<unknown, PiRpcError>();
          const id = yield* prompt(record, deferred);
          return yield* Deferred.await(deferred).pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(new PiRpcTimeoutError({ operation: "prompt", timeoutMs })),
            }),
            Effect.onError(() => Effect.sync(() => prompts.remove(id))),
          );
        }
        case "clear_queue": {
          const result = ompRecord(
            yield* connection.request({ type: "abort_and_restore_queue" }, timeoutMs),
          );
          stopped = true;
          return Object.fromEntries(
            ["steering", "followUp"].map((key) => [
              key,
              Array.isArray(result[key])
                ? result[key]
                    .map((message) => ompRecord(message).text)
                    .filter((v): v is string => typeof v === "string")
                : [],
            ]),
          );
        }
        case "abort":
          if (stopped) {
            stopped = false;
            return undefined;
          }
          return yield* connection.request(
            { ...record, type: "abort_and_restore_queue" },
            timeoutMs,
          );
        case "extension_request": {
          const target = ompRecord(record.data).nativeThreadId;
          const epoch = todos.generation;
          if (record.name === "cox.omp.todo") {
            const value = yield* connection.request({ type: "get_state" }, timeoutMs);
            if (epoch !== todos.generation) return undefined;
            const snapshot = bind(value);
            return target === undefined || target === snapshot.sessionFile ? snapshot : undefined;
          }
          if (record.name === "cox.omp.tasks") {
            if (target !== todos.nativeThreadId || typeof target !== "string") return undefined;
            yield* agents.refresh(connection.request);
            return epoch === todos.generation ? agents.snapshot(target) : undefined;
          }
          return yield* new PiRpcError({
            operation: "extension_request",
            detail: `Unknown Cox request: ${String(record.name)}`,
          });
        }
        case "get_commands":
          return yield* connection.request(
            { ...record, type: "get_available_commands" },
            timeoutMs,
          );
        case "set_todos": {
          const result = yield* connection.request(record, timeoutMs);
          yield* refreshTodos();
          return result;
        }
        case "get_state":
          return bind(yield* connection.request(record, timeoutMs));
        case "new_session":
        case "switch_session":
        case "open_session":
        case "fork":
        case "navigate_tree": {
          const command =
            record.type === "fork" && typeof record.entryId === "string"
              ? yield* ompForkBeforeEntry(
                  record,
                  yield* connection.request({ type: "get_entries" }, timeoutMs),
                )
              : record;
          reset();
          const result = yield* connection.request(command, timeoutMs);
          bind(yield* connection.request({ type: "get_state" }, timeoutMs));
          yield* refreshTodos();
          return result;
        }
        default:
          return yield* connection.request(record, timeoutMs);
      }
    });
    const send: PiRpcConnection["send"] = Effect.fnUntraced(function* (record) {
      if (record.type === "prompt") {
        yield* prompt(record);
        return;
      }
      if (record.type === "extension_ui_response")
        return yield* connection.send(prompts.uiResponse(record));
      if (
        ["clear_queue", "abort", "get_commands", "extension_request"].includes(String(record.type))
      ) {
        const data = yield* request(record).pipe(
          Effect.mapError((cause) =>
            cause._tag === "PiRpcError"
              ? cause
              : new PiRpcError({ operation: String(record.type), cause }),
          ),
        );
        yield* Queue.offer(events, {
          type: "response",
          command: record.type,
          success: true,
          data,
          ...(record.id === undefined ? {} : { id: record.id }),
        });
        return;
      }
      yield* connection.send(record);
    });
    yield* Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(connection.events);
        switch (event.type) {
          case "ready":
            yield* Deferred.succeed(ready, undefined);
            break;
          case "response": {
            const acknowledgement = yield* prompts.acknowledge(event);
            if (acknowledgement !== undefined) yield* Queue.offer(events, acknowledgement);
            continue;
          }
          case "prompt_result":
            prompts.observe(event);
            continue;
          case "queue_update":
            prompts.queueUpdate(event);
            break;
          case "session_settled":
            yield* refreshTodos();
            for (const settled of prompts.settle()) yield* Queue.offer(events, settled);
            continue;
          case "subagent_lifecycle":
          case "subagent_progress":
          case "subagent_event":
            agents.observe(event, yield* Clock.currentTimeMillis);
            if (typeof todos.nativeThreadId === "string")
              yield* Queue.offer(events, agents.snapshot(todos.nativeThreadId));
            continue;
          case "extension_ui_request":
            yield* Queue.offer(events, prompts.uiRequest(event));
            continue;
          case "tool_execution_end":
            if (event.toolName === "todo" && event.isError !== true) yield* refreshTodos();
            break;
        }
        yield* Queue.offer(events, event);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const error = new PiRpcError({ operation: "events", cause });
          yield* Deferred.fail(ready, error);
          prompts.reset(error);
          yield* Queue.fail(events, error);
        }),
      ),
      Effect.forkIn(scope),
    );
    yield* Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: Duration.seconds(30),
        orElse: () =>
          Effect.fail(new PiRpcError({ operation: "startup", detail: "OMP ready timed out" })),
      }),
    );
    const startupRequest = (record: PiRpcRecord) =>
      connection
        .request(record)
        .pipe(Effect.mapError((cause) => new PiRpcError({ operation: "startup", cause })));
    yield* startupRequest({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!decoder.negotiated)
      return yield* new PiRpcError({
        operation: "startup",
        detail: "OMP did not confirm protocol v2",
      });
    yield* startupRequest({ type: "set_subagent_subscription", level: "events" });
    bind(yield* startupRequest({ type: "get_state" }));
    return { ...connection, send, request, events } satisfies PiRpcConnection;
  },
);
