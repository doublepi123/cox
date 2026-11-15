import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiRpcRecord } from "@t3tools/provider-pi/server";
import { makeOmpRpcConnection } from "./runtime.ts";
import { ompRecord } from "./framing.ts";
import { ompTodoSnapshot } from "./todo.ts";

const harness = Effect.fnUntraced(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const writes = yield* Queue.unbounded<PiRpcRecord>();
  const records: PiRpcRecord[] = [];
  let state: PiRpcRecord = {
    sessionId: "parent-1",
    sessionFile: "/parent-1",
    isStreaming: false,
    isCompacting: false,
    queuedMessageCount: 0,
    hasPendingAsyncWork: false,
    isSettled: true,
    todoPhases: [],
  };
  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, Buffer.from(`${JSON.stringify(record)}\n`));
  yield* emit({
    type: "ready",
    protocolVersion: 1,
    supportedProtocolVersions: [1, 2],
    maxFrameBytes: 1048576,
    maxReassembledFrameBytes: 67108864,
  });
  const spawner = ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(98765432),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.gen(function* () {
            const record = ompRecord(JSON.parse(Buffer.from(bytes).toString()));
            records.push(record);
            yield* Queue.offer(writes, record);
            if (record.type === "prompt" || record.type === "extension_ui_response") return;
            if (record.type === "negotiate_protocol" && record.protocolVersion !== 2) {
              yield* emit({
                type: "response",
                id: record.id,
                command: record.type,
                success: false,
                error: `Unsupported RPC protocol version: ${String(record.protocolVersion)}`,
              });
              return;
            }
            if (record.type === "get_messages") {
              const payload = Buffer.from(
                JSON.stringify({
                  type: "response",
                  command: "get_messages",
                  id: record.id,
                  success: true,
                  data: { text: "native".repeat(200_000) },
                }),
              );
              const count = Math.ceil(payload.length / (256 * 1024));
              for (let index = 0; index < count; index++)
                yield* emit({
                  type: "rpc_chunk",
                  chunkId: "native-wire",
                  index,
                  count,
                  byteLength: payload.length,
                  data: payload
                    .subarray(index * 256 * 1024, (index + 1) * 256 * 1024)
                    .toString("base64"),
                });
              return;
            }
            const data =
              record.type === "negotiate_protocol"
                ? { protocolVersion: 2 }
                : record.type === "get_state"
                  ? state
                  : record.type === "get_subagents"
                    ? { subagents: [] }
                    : record.type === "get_available_commands"
                      ? { commands: [{ name: "native-command" }] }
                      : record.type === "get_available_thinking_levels"
                        ? { levels: ["off", "high"] }
                        : record.type === "set_model"
                          ? { provider: record.provider, id: record.modelId, contextWindow: 200000 }
                          : record.type === "abort_and_restore_queue"
                            ? { steering: [{ text: "withdrawn" }], followUp: [] }
                            : {};
            yield* emit({
              type: "response",
              id: record.id,
              command: record.type,
              success: true,
              data,
            });
          }),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
  const connection = yield* makeOmpRpcConnection({
    command: "omp",
    args: [],
    cwd: undefined,
    env: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const takeWrite = (type: string) =>
    Effect.gen(function* () {
      while (true) {
        const record = yield* Queue.take(writes);
        if (record.type === type) return record;
      }
    });
  const takeEvent = (type: string) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(connection.events);
        if (event.type === type) return event;
      }
    });
  return {
    connection,
    emit,
    takeWrite,
    takeEvent,
    records,
    setState: (next: PiRpcRecord) => {
      state = { ...state, ...next };
    },
  };
});

describe("OMP native wire normalization", () => {
  it.effect(
    "correlates prompt outcomes and waits for session settlement across a background wake",
    () =>
      Effect.gen(function* () {
        const fake = yield* harness();
        yield* fake.connection.request({ type: "get_state" });
        yield* fake.connection.send({ type: "prompt", message: "work" });
        const prompt = yield* fake.takeWrite("prompt");
        yield* fake.emit({ type: "response", command: "prompt", id: prompt.id, success: true });
        const ack = yield* fake.takeEvent("response");
        assert.isUndefined(ack.id);
        yield* fake.emit({ type: "agent_end", messages: [] });
        assert.equal((yield* fake.takeEvent("agent_end")).type, "agent_end");
        yield* fake.emit({
          type: "prompt_result",
          id: prompt.id,
          status: "error",
          error: { message: "native failure" },
          agentInvoked: true,
          sessionSettled: false,
        });
        yield* fake.emit({
          type: "prompt_result",
          id: "unowned",
          status: "error",
          error: { message: "wrong owner" },
          agentInvoked: true,
          sessionSettled: false,
        });
        yield* fake.emit({ type: "agent_start" });
        assert.equal((yield* fake.takeEvent("agent_start")).type, "agent_start");
        yield* fake.emit({
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "stop" },
        });
        expect(yield* fake.takeEvent("message_end")).toMatchObject({
          message: { stopReason: "stop" },
        });
        yield* fake.emit({ type: "session_settled" });
        const settlement: PiRpcRecord[] = [];
        while (true) {
          const event = yield* Queue.take(fake.connection.events);
          settlement.push(event);
          if (event.type === "agent_settled") break;
        }
        expect(settlement.filter((event) => event.type === "message_end")).toMatchObject([
          {
            message: { stopReason: "error", errorMessage: "native failure" },
          },
        ]);
        expect(settlement.at(-1)).toMatchObject({ type: "agent_settled", aborted: false });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves admission errors and native approval labels", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      yield* fake.connection.send({ type: "prompt", message: "rejected" });
      const prompt = yield* fake.takeWrite("prompt");
      yield* fake.emit({
        type: "response",
        command: "prompt",
        id: prompt.id,
        success: false,
        error: "Admission denied",
      });
      expect(yield* fake.takeEvent("response")).toMatchObject({
        success: false,
        error: "Admission denied",
      });
      yield* fake.emit({
        type: "extension_ui_request",
        id: "approval-1",
        method: "select",
        title: "Approve write?",
        options: ["Approve Once", "Approve for Session", "Deny"],
      });
      expect(yield* fake.takeEvent("extension_ui_request")).toMatchObject({ method: "confirm" });
      yield* fake.connection.send({
        type: "extension_ui_response",
        id: "approval-1",
        confirmed: true,
      });
      expect(yield* fake.takeWrite("extension_ui_response")).toMatchObject({
        value: "Approve Once",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "withdraws queued input atomically and retains native commands, models and thinking",
    () =>
      Effect.gen(function* () {
        const fake = yield* harness();
        yield* fake.connection.send({
          type: "prompt",
          message: "withdrawn",
          streamingBehavior: "steer",
        });
        const queued = yield* fake.takeWrite("prompt");
        yield* fake.emit({
          type: "queue_update",
          steering: ["withdrawn"],
          followUp: [],
          liveSteered: 0,
        });
        yield* fake.emit({ type: "response", command: "prompt", id: queued.id, success: true });
        expect(yield* fake.takeEvent("response")).toMatchObject({
          data: { disposition: "queued" },
        });
        assert.deepEqual(yield* fake.connection.request({ type: "clear_queue" }), {
          steering: ["withdrawn"],
          followUp: [],
        });
        yield* fake.connection.send({ type: "abort" });
        assert.equal(
          (yield* fake.takeWrite("abort_and_restore_queue")).type,
          "abort_and_restore_queue",
        );
        expect(yield* fake.connection.request({ type: "get_commands" })).toEqual({
          commands: [{ name: "native-command" }],
        });
        expect(
          yield* fake.connection.request({
            type: "set_model",
            provider: "native",
            modelId: "exact/id",
          }),
        ).toEqual({ provider: "native", id: "exact/id", contextWindow: 200000 });
        expect(yield* fake.connection.request({ type: "get_available_thinking_levels" })).toEqual({
          levels: ["off", "high"],
        });
        assert.deepEqual(
          fake.records
            .filter((record) =>
              ["clear_queue", "abort", "abort_and_restore_queue"].includes(String(record.type)),
            )
            .map((record) => record.type),
          ["abort_and_restore_queue"],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "uses conservative idle fields and refreshes native todos on settlement and session switch",
    () =>
      Effect.gen(function* () {
        const fake = yield* harness();
        fake.setState({ queuedMessageCount: 2, hasPendingAsyncWork: true, isSettled: false });
        expect(yield* fake.connection.request({ type: "get_state" })).toMatchObject({
          pendingMessageCount: 3,
        });
        fake.setState({
          queuedMessageCount: 0,
          hasPendingAsyncWork: false,
          isSettled: true,
          todoPhases: [
            { name: "Native", tasks: [{ content: "Eval todo", status: "in_progress" }] },
          ],
        });
        yield* fake.emit({ type: "session_settled" });
        const update = yield* fake.takeEvent("extension_event");
        expect(ompTodoSnapshot(update.data)?.steps).toMatchObject([
          { text: "Native: Eval todo", status: "running" },
        ]);
        const old = yield* fake.connection.request({
          type: "extension_request",
          name: "cox.omp.todo",
          data: { nativeThreadId: "/parent-1" },
        });
        fake.setState({ sessionId: "parent-2", sessionFile: "/parent-2", todoPhases: [] });
        yield* fake.connection.request({ type: "switch_session", sessionPath: "/parent-2" });
        const next = yield* fake.connection.request({
          type: "extension_request",
          name: "cox.omp.todo",
          data: { nativeThreadId: "/parent-2" },
        });
        assert.notEqual(ompRecord(old).generation, ompRecord(next).generation);
        assert.isUndefined(
          yield* fake.connection.request({
            type: "extension_request",
            name: "cox.omp.todo",
            data: { nativeThreadId: "/parent-1" },
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("routes a negotiated chunked response to its pending native request", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      expect(yield* fake.connection.request({ type: "get_messages" })).toEqual({
        text: "native".repeat(200_000),
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps request prompt ownership when its abort result precedes admission acknowledgement",
    () =>
      Effect.gen(function* () {
        const fake = yield* harness();
        yield* fake.connection.request({ type: "get_state" });
        const requesting = yield* fake.connection
          .request({ type: "prompt", message: "cancelled" })
          .pipe(Effect.forkChild);
        const prompt = yield* fake.takeWrite("prompt");
        yield* fake.emit({
          type: "prompt_result",
          id: prompt.id,
          status: "aborted",
          agentInvoked: true,
          sessionSettled: true,
        });
        yield* fake.emit({
          type: "response",
          id: prompt.id,
          command: "prompt",
          success: true,
          data: { agentInvoked: true },
        });
        expect(yield* Fiber.join(requesting)).toEqual({ agentInvoked: true });
        yield* fake.emit({ type: "session_settled" });
        expect(yield* fake.takeEvent("agent_settled")).toMatchObject({ aborted: true });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("fails the normalized event stream on malformed native chunks", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      yield* fake.emit({
        type: "rpc_chunk",
        chunkId: "invalid",
        index: 1,
        count: 5,
        byteLength: 1048576,
        data: "YQ==",
      });
      const error = yield* fake.takeEvent("never").pipe(Effect.flip);
      assert.equal(error._tag, "PiRpcError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
