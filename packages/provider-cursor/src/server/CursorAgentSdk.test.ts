import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { vi } from "vite-plus/test";

import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";

const cursorSdkMock = vi.hoisted(() => {
  const closeExecutionOrder: Array<string> = [];
  const runOperations: Array<string> = [];
  let agentCloseFailure: unknown;
  let staleRunActive = false;
  const runWait = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    requestId: "request-cursor-agent-sdk-test",
    status: "finished",
    result: "ok",
    model: { id: "default" },
    durationMs: 1,
  }));
  const runCancel = vi.fn(async () => {});
  const prewarmRelease = vi.fn(async () => {});
  const prewarmLocalWorkspace = vi.fn(async () => prewarmRelease);
  const createAgentPlatform = vi.fn(async () => ({ prewarmLocalWorkspace }));
  const agentClose = vi.fn(() => {
    closeExecutionOrder.push("sdk:agent.close");
    if (agentCloseFailure !== undefined) {
      throw agentCloseFailure;
    }
  });
  const send = vi.fn(
    async (
      _message: unknown,
      options: { readonly onDelta?: (input: { readonly update: unknown }) => Promise<void> },
    ) => {
      runOperations.push("run.start");
      if (staleRunActive) {
        throw new Error("Agent agent-cursor-agent-sdk-test already has active run");
      }
      await options.onDelta?.({
        update: {
          type: "assistant-message-chunk",
          text: "hello",
        },
      });
      return {
        id: "run-cursor-agent-sdk-test",
        agentId: "agent-cursor-agent-sdk-test",
        wait: runWait,
        cancel: runCancel,
      };
    },
  );
  const create = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    close: agentClose,
  }));
  const listRuns = vi.fn(async () => {
    runOperations.push("agent.listRuns");
    return {
      items: staleRunActive ? [{ id: "run-stale", status: "running" }] : [],
    };
  });
  const cancelRun = vi.fn(async () => {
    runOperations.push("agent.cancelRun");
    staleRunActive = false;
  });

  return {
    agentClose,
    cancelRun,
    closeExecutionOrder,
    create,
    createAgentPlatform,
    prewarmLocalWorkspace,
    prewarmRelease,
    listRuns,
    resume,
    runOperations,
    runCancel,
    runWait,
    send,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  Agent: {
    create: cursorSdkMock.create,
    resume: cursorSdkMock.resume,
    listRuns: cursorSdkMock.listRuns,
    cancelRun: cursorSdkMock.cancelRun,
    messages: {
      list: vi.fn(async () => []),
    },
  },
  createAgentPlatform: cursorSdkMock.createAgentPlatform,
  SqliteLocalAgentStore: { open: vi.fn() },
}));

const layerTest = CursorAgentSdk.layer.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, {
      native: {
        filePath: "cursor-agent-sdk-test.log",
        write: (event: unknown) =>
          Effect.sync(() => {
            if (
              typeof event === "object" &&
              event !== null &&
              Reflect.get(Reflect.get(event, "event"), "payload")?.type === "agent.close"
            ) {
              cursorSdkMock.closeExecutionOrder.push("protocol:agent.close");
            }
          }),
        close: () => Effect.void,
      },
      canonical: undefined,
    }),
  ),
  Layer.provide(CursorSdk.layer),
  Layer.provide(NodeServices.layer),
);

describe("CursorAgentSdkRunner", () => {
  it.effect("primes sandbox support once for concurrent full-access sessions", () =>
    Effect.gen(function* () {
      cursorSdkMock.createAgentPlatform.mockClear();
      cursorSdkMock.prewarmLocalWorkspace.mockClear();
      cursorSdkMock.prewarmRelease.mockClear();
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      yield* Effect.all(
        Array.from({ length: 3 }, () =>
          runner.open({
            operation: "create",
            options: { local: { cwd: process.cwd(), sandboxOptions: { enabled: false } } },
            threadId: ThreadId.make("thread-cursor-prewarm-test"),
            providerSessionId: ProviderSessionId.make("session-cursor-prewarm-test"),
          }),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(cursorSdkMock.createAgentPlatform.mock.calls.length, 1);
      assert.strictEqual(cursorSdkMock.prewarmLocalWorkspace.mock.calls.length, 1);
      assert.strictEqual(cursorSdkMock.prewarmRelease.mock.calls.length, 1);
      assert.deepStrictEqual(cursorSdkMock.prewarmLocalWorkspace.mock.calls[0], [
        {
          local: { cwd: process.cwd(), settingSources: [], sandboxOptions: { enabled: true } },
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["platform", "prewarm", "release"] as const)(
    "logs the original %s failure without blocking full-access sessions",
    (stage) => {
      const warnings: Array<unknown> = [];
      const logger = Logger.make(({ message }) => {
        warnings.push(message);
      });
      const originalFailure = new Error("sandbox initialization failed before module export");
      return Effect.gen(function* () {
        cursorSdkMock.prewarmLocalWorkspace.mockClear();
        cursorSdkMock.createAgentPlatform.mockClear();
        if (stage === "platform") {
          cursorSdkMock.createAgentPlatform.mockRejectedValueOnce(originalFailure);
        } else if (stage === "prewarm") {
          cursorSdkMock.prewarmLocalWorkspace.mockRejectedValueOnce(originalFailure);
        } else {
          cursorSdkMock.prewarmRelease.mockRejectedValueOnce(originalFailure);
        }
        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        yield* Effect.all(
          Array.from({ length: 3 }, () =>
            runner.open({
              operation: "create",
              options: { local: { cwd: process.cwd(), sandboxOptions: { enabled: false } } },
              threadId: ThreadId.make("thread-cursor-prewarm-failure-test"),
              providerSessionId: ProviderSessionId.make("session-cursor-prewarm-failure-test"),
            }),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(cursorSdkMock.createAgentPlatform.mock.calls.length, 1);
        assert.strictEqual(
          cursorSdkMock.prewarmLocalWorkspace.mock.calls.length,
          stage === "platform" ? 0 : 1,
        );
        assert.strictEqual(warnings.length, 1);
        const messages = warnings.flat();
        assert.include(
          messages,
          `Cursor Agent SDK sandbox.prewarm failed: ${originalFailure.message}`,
        );
        const failure = messages.find(CursorAgentSdk.isCursorAgentSdkRunnerError);
        assert.strictEqual(failure?.cause, originalFailure);
      }).pipe(Effect.provide([layerTest, Logger.layer([logger], { mergeWithExisting: false })]));
    },
  );

  it.effect("retries a resumed send after cancelling its abandoned local run", () =>
    Effect.gen(function* () {
      cursorSdkMock.runOperations.length = 0;
      cursorSdkMock.listRuns.mockClear();
      cursorSdkMock.cancelRun.mockClear();
      cursorSdkMock.setStaleRunActive(true);

      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "resume",
        agentId: "agent-cursor-agent-sdk-test",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-stale-run-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-stale-run-test",
        ),
      });
      assert.deepStrictEqual(cursorSdkMock.runOperations, []);
      const run = yield* session.send({ message: "continue" });
      yield* run.wait;

      assert.deepStrictEqual(cursorSdkMock.runOperations, [
        "run.start",
        "agent.listRuns",
        "agent.cancelRun",
        "run.start",
      ]);
      assert.deepStrictEqual(cursorSdkMock.listRuns.mock.calls[0], [
        "agent-cursor-agent-sdk-test",
        { runtime: "local", cwd: process.cwd(), limit: 1 },
      ]);
      assert.deepStrictEqual(cursorSdkMock.cancelRun.mock.calls[0], [
        "run-stale",
        {
          runtime: "local",
          cwd: process.cwd(),
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );
});
