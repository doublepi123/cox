import { assert, describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type { PiRpcRecord } from "@t3tools/provider-pi/server";
import { makeOmpRpcConnection } from "./runtime.ts";
import { ompRecord } from "./framing.ts";

const harness = Effect.fnUntraced(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array>();
  const writes = yield* Queue.unbounded<PiRpcRecord>();
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
            const data =
              record.type === "negotiate_protocol"
                ? { protocolVersion: 2 }
                : record.type === "get_state"
                  ? state
                  : record.type === "get_subagents"
                    ? { subagents: [] }
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
  const drainUntilSentinel = Effect.fnUntraced(function* () {
    const collected: PiRpcRecord[] = [];
    while (true) {
      const event = yield* Queue.take(connection.events);
      if (event.type === "agent_start") return collected;
      if (event.type === "ready") continue;
      collected.push(event);
    }
  });
  return { connection, emit, drainUntilSentinel };
});

describe("OMP compaction wire normalization", () => {
  it.effect("normalizes manual and automatic compaction starts with native fields", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      yield* fake.emit({ type: "manual_compaction_start", mode: "soft", futureField: 7 });
      yield* fake.emit({ type: "auto_compaction_start", reason: "threshold", action: "shake" });
      yield* fake.emit({ type: "agent_start" });
      const collected = yield* fake.drainUntilSentinel();
      const compactionStarts = collected.filter((event) =>
        ["compaction_start", "manual_compaction_start", "auto_compaction_start"].includes(
          String(event.type),
        ),
      );
      expect(compactionStarts.map((event) => event.type)).toEqual([
        "compaction_start",
        "compaction_start",
      ]);
      expect(compactionStarts[0]).toMatchObject({ mode: "soft", futureField: 7 });
      expect(compactionStarts[1]).toMatchObject({ reason: "threshold", action: "shake" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves success, cancellation and failure outcomes on compaction ends", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      const nativeResult = {
        summary: "Rolled the session into a deterministic summary.",
        shortSummary: "Deterministic summary",
        firstKeptEntryId: "entry-9",
        tokensBefore: 12345,
        details: { kind: "soft" },
      };
      yield* fake.emit({
        type: "manual_compaction_end",
        result: nativeResult,
        aborted: false,
        extraEndField: true,
      });
      yield* fake.emit({
        type: "auto_compaction_end",
        action: "context-full",
        result: { ...nativeResult, tokensBefore: 4242 },
        aborted: false,
        willRetry: true,
      });
      yield* fake.emit({
        type: "auto_compaction_end",
        action: "shake",
        result: undefined,
        aborted: true,
        willRetry: false,
      });
      yield* fake.emit({
        type: "auto_compaction_end",
        action: "context-full",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: "Summarizer exploded",
      });
      yield* fake.emit({ type: "agent_start" });
      const collected = yield* fake.drainUntilSentinel();
      const ends = collected.filter((event) => String(event.type).includes("compaction_end"));
      expect(ends.map((event) => event.type)).toEqual([
        "compaction_end",
        "compaction_end",
        "compaction_end",
        "compaction_end",
      ]);
      expect(ends[0]).toMatchObject({ result: nativeResult, aborted: false, extraEndField: true });
      expect(ends[1]).toMatchObject({
        action: "context-full",
        willRetry: true,
        result: { tokensBefore: 4242 },
      });
      expect(ends[2]).toMatchObject({ aborted: true, willRetry: false });
      assert.isUndefined(ends[2]?.result);
      expect(ends[3]).toMatchObject({ aborted: false, errorMessage: "Summarizer exploded" });
      assert.isUndefined(ends[3]?.result);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("maps skipped no-op ends to benign completed outcomes, never failures", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      yield* fake.emit({
        type: "manual_compaction_end",
        aborted: false,
        skipped: true,
        errorMessage: "Nothing to compact (session too small or already rolled over)",
      });
      yield* fake.emit({
        type: "auto_compaction_end",
        action: "context-full",
        result: undefined,
        aborted: false,
        willRetry: false,
        skipped: true,
      });
      yield* fake.emit({
        type: "manual_compaction_end",
        result: { summary: "Real compaction wins over a stray skipped flag" },
        aborted: false,
        skipped: true,
      });
      yield* fake.emit({ type: "agent_start" });
      const collected = yield* fake.drainUntilSentinel();
      const ends = collected.filter((event) => String(event.type).includes("compaction_end"));
      expect(ends.map((event) => event.type)).toEqual([
        "compaction_end",
        "compaction_end",
        "compaction_end",
      ]);
      expect(ends[0]).toMatchObject({
        aborted: false,
        skipped: true,
        errorMessage: "Nothing to compact (session too small or already rolled over)",
        result: { summary: "Nothing to compact (session too small or already rolled over)" },
      });
      expect(ends[1]).toMatchObject({
        aborted: false,
        skipped: true,
        willRetry: false,
        result: { summary: expect.any(String) },
      });
      const autoSkip = ends[1];
      assert(autoSkip !== undefined);
      const autoSkipSummary = ompRecord(autoSkip.result).summary;
      assert(typeof autoSkipSummary === "string");
      expect(autoSkipSummary.length).toBeGreaterThan(0);
      expect(ends[2]?.result).toMatchObject({
        summary: "Real compaction wins over a stray skipped flag",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves non-compaction events untouched", () =>
    Effect.gen(function* () {
      const fake = yield* harness();
      yield* fake.emit({ type: "agent_end", yielded: false, awaitingAsyncWork: false });
      yield* fake.emit({ type: "message_end", message: { role: "assistant", content: [] } });
      yield* fake.emit({ type: "agent_start" });
      const collected = yield* fake.drainUntilSentinel();
      expect(collected.map((event) => event.type)).toEqual(["agent_end", "message_end"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
