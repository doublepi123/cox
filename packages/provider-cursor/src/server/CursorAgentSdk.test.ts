import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
  const summarize = vi.fn(async () => ({
    id: "run-cursor-agent-sdk-test",
    agentId: "agent-cursor-agent-sdk-test",
    wait: runWait,
    cancel: runCancel,
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
  const create = vi.fn(async (_options?: unknown) => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    summarize,
    close: agentClose,
  }));
  const resume = vi.fn(async () => ({
    agentId: "agent-cursor-agent-sdk-test",
    send,
    summarize,
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

  const sqliteOpen = vi.fn<(options: { workspaceRef: string }) => Promise<unknown>>(
    async () => undefined,
  );

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
    summarize,
    sqliteOpen,
    setAgentCloseFailure: (failure: unknown) => {
      agentCloseFailure = failure;
    },
    setStaleRunActive: (active: boolean) => {
      staleRunActive = active;
    },
  };
});

vi.mock("./sdk.ts", () => ({
  loadCursorSdk: () => ({
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
  }),
  loadCursorSqlite: () => ({ SqliteLocalAgentStore: { open: cursorSdkMock.sqliteOpen } }),
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
  it.effect("keeps an agent's background shells and reports each start and end in order", () =>
    Effect.gen(function* () {
      const start = (conversationId: string, id: number) => {
        let complete: (completion: object) => void = () => {};
        const abort = vi.fn();
        const kept: unknown = (
          Reflect.get(globalThis, Symbol.for("@cursor/sdk.backgroundShell")) as (
            input: unknown,
          ) => boolean
        )({
          conversationId,
          command: "sleep 60",
          shell: {
            id,
            pid: id + 1,
            abort,
            onComplete: (listener: typeof complete) => (complete = listener),
          },
        });
        return { kept, abort, complete: (completion: object) => complete(completion) };
      };
      const events: Array<object> = [];
      const stops: Array<() => void> = [];
      const reported = yield* Deferred.make<void>();
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: {},
        threadId: ThreadId.make("thread-cursor-agent-sdk-background"),
        providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-background"),
      });
      const run = yield* session.send({
        message: "watch it",
        onBackgroundShell: (event) =>
          Effect.gen(function* () {
            if (event.type === "started") {
              const { stop, ...started } = event;
              stops.push(stop);
              events.push(started);
              return;
            }
            events.push(event);
            if (!event.stopped) yield* Deferred.succeed(reported, undefined);
          }),
      });
      yield* run.wait;

      const killed = start("agent-cursor-agent-sdk-test", 10);
      const finished = start("agent-cursor-agent-sdk-test", 20);
      const foreign = start("agent-someone-else", 30);
      killed.complete({ code: null, aborted: true });
      finished.complete({ code: 3, aborted: false, outputPath: "/terminals/20.txt" });
      yield* Deferred.await(reported);
      stops[0]!();

      assert.deepStrictEqual([killed.kept, finished.kept, foreign.kept], [true, true, false]);
      assert.strictEqual(killed.abort.mock.calls.length, 1);
      const shell = (id: string, pid: number) => ({ id, pid, command: "sleep 60" });
      assert.deepStrictEqual(events, [
        { ...shell("10", 11), type: "started" },
        { ...shell("20", 21), type: "started" },
        {
          ...shell("10", 11),
          type: "ended",
          stopped: true,
          exitCode: undefined,
          outputPath: undefined,
        },
        {
          ...shell("20", 21),
          type: "ended",
          stopped: false,
          exitCode: 3,
          outputPath: "/terminals/20.txt",
        },
      ]);
    }).pipe(Effect.provide(layerTest)),
  );
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

  it.effect("uses SDK summarize without sending a synthetic user message", () =>
    Effect.gen(function* () {
      const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const session = yield* runner.open({
        operation: "create",
        options: { model: { id: "default" }, mode: "agent", local: { cwd: process.cwd() } },
        threadId: ThreadId.make("thread-cursor-agent-sdk-summarize-test"),
        providerSessionId: ProviderSessionId.make(
          "provider-session-cursor-agent-sdk-summarize-test",
        ),
      });
      cursorSdkMock.send.mockClear();
      cursorSdkMock.summarize.mockClear();

      yield* session.send({ message: "/compress", summarize: true });

      assert.strictEqual(cursorSdkMock.summarize.mock.calls.length, 1);
      assert.strictEqual(cursorSdkMock.send.mock.calls.length, 0);
    }).pipe(Effect.provide(layerTest)),
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
        { runtime: "local", cwd: process.cwd() },
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

  it.effect(
    "ref-counts one disposable SqliteLocalAgentStore with no-op runEvents per workspace",
    () =>
      Effect.gen(function* () {
        const dispose = vi.fn(async () => {});
        const underlyingAppend = vi.fn(async () => {
          throw new Error("runEvents.append must not hit SQLite");
        });
        const fakeStore = {
          agents: { get: vi.fn() },
          runs: { list: vi.fn() },
          checkpoints: { save: vi.fn() },
          runEvents: { append: underlyingAppend, list: vi.fn(), delete: vi.fn() },
          dispose,
        };
        cursorSdkMock.sqliteOpen.mockClear();
        cursorSdkMock.sqliteOpen.mockResolvedValueOnce(fakeStore);
        cursorSdkMock.create.mockClear();

        const runner = yield* CursorAgentSdk.CursorAgentSdkRunner;
        const session = yield* runner.open({
          operation: "create",
          options: { local: { cwd: "/workspace/cursor-store-test" } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-store"),
          providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-store"),
        });
        const peer = yield* runner.open({
          operation: "create",
          options: { local: { cwd: "/workspace/cursor-store-test" } },
          threadId: ThreadId.make("thread-cursor-agent-sdk-store-peer"),
          providerSessionId: ProviderSessionId.make("provider-session-cursor-agent-sdk-store-peer"),
        });

        assert.deepStrictEqual(cursorSdkMock.sqliteOpen.mock.calls, [
          [{ workspaceRef: "/workspace/cursor-store-test" }],
        ]);
        const passedOptions = cursorSdkMock.create.mock.calls[0]?.[0] as
          | {
              readonly local?: {
                readonly store?: {
                  readonly agents: unknown;
                  readonly checkpoints: unknown;
                  readonly runEvents: {
                    readonly append: (event: {
                      readonly runId: string;
                      readonly eventType: string;
                      readonly payload?: unknown;
                    }) => Promise<{ readonly seq: number }>;
                  };
                };
              };
            }
          | undefined;
        const peerOptions = cursorSdkMock.create.mock.calls[1]?.[0] as typeof passedOptions;
        const passedStore = passedOptions?.local?.store;
        assert.isDefined(passedStore);
        assert.strictEqual(peerOptions?.local?.store, passedStore);
        assert.strictEqual(passedStore?.agents, fakeStore.agents);
        assert.strictEqual(passedStore?.checkpoints, fakeStore.checkpoints);
        const appended = yield* Effect.promise(() =>
          passedStore!.runEvents.append({
            runId: "run-1",
            eventType: "text-delta",
            payload: { text: "hi" },
          }),
        );
        assert.equal(appended.seq, 1);
        assert.equal(underlyingAppend.mock.calls.length, 0);
        assert.equal(dispose.mock.calls.length, 0);

        // Closing one session keeps the shared workspace store alive; repeated close does not double-release.
        yield* session.close;
        yield* session.close;
        assert.equal(dispose.mock.calls.length, 0);

        yield* peer.close;
        assert.equal(dispose.mock.calls.length, 1);

        // Failed open disposes the newly opened store instead of leaking SQLite FDs.
        const failingDispose = vi.fn(async () => {});
        cursorSdkMock.sqliteOpen.mockResolvedValueOnce({ ...fakeStore, dispose: failingDispose });
        cursorSdkMock.create.mockRejectedValueOnce(new Error("boom"));
        const failed = yield* runner
          .open({
            operation: "create",
            options: { local: { cwd: "/workspace/cursor-store-fail" } },
            threadId: ThreadId.make("thread-cursor-agent-sdk-store-fail"),
            providerSessionId: ProviderSessionId.make(
              "provider-session-cursor-agent-sdk-store-fail",
            ),
          })
          .pipe(Effect.exit);
        assert(Exit.isFailure(failed));
        assert.equal(failingDispose.mock.calls.length, 1);
      }).pipe(Effect.provide(layerTest)),
  );
});
