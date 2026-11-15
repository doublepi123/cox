import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_MODEL_SERVICE_RECOVERY, ModelServiceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";

import {
  buildCredentialRotationHarness,
  INSTANCE_MAIN,
  INSTANCE_PEER,
  invokeGatewayModels,
  OMO_DRIVER,
  SERVICE_A,
  SERVICE_B,
} from "./ProviderSessionCredentialRotation.testkit.ts";

describe("ProviderSessionManager credential rotation", () => {
  it.effect(
    "replaces only the rebound instance's live session on A->B while preserving native history, worktree, model, and thinking",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        const peerWorktree = yield* fs.makeTempDirectoryScoped();
        const h = yield* buildCredentialRotationHarness();

        const main = yield* h.createThreadFixture({
          threadId: ThreadId.make("thread-rebind-main"),
          instanceId: INSTANCE_MAIN,
          cwd: worktree,
          nativeThreadId: "native-omo-main-jsonl",
        });
        const peer = yield* h.createThreadFixture({
          threadId: ThreadId.make("thread-rebind-peer"),
          instanceId: INSTANCE_PEER,
          cwd: peerWorktree,
          nativeThreadId: "native-omo-peer-jsonl",
        });

        const runtimeA = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
          initialNativeThreadId: "native-omo-main-jsonl",
        });
        yield* runtimeA.resumeThread({
          providerThread: main.providerThread,
          threadId: main.appThread.id,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtimeA, 1);

        const peerRuntime = yield* h.manager.open({
          threadId: peer.appThread.id,
          providerSessionId: peer.providerSessionId,
          modelSelection: peer.selection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: peerWorktree,
          },
          initialNativeThreadId: "native-omo-peer-jsonl",
        });
        yield* peer.runTurn(peerRuntime, 1);

        const mainMetrics = h.metricsFor(INSTANCE_MAIN);
        const peerMetrics = h.metricsFor(INSTANCE_PEER);
        const tokenA = mainMetrics.tokensAtOpen[0];
        assert.isDefined(tokenA);
        assert.equal(mainMetrics.openCount, 1);
        assert.equal(peerMetrics.openCount, 1);

        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            enabled: true,
            modelService: { serviceId: SERVICE_B, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });
        yield* h.reconcileNow;

        const staleCheck = yield* invokeGatewayModels(h.gateway, tokenA);
        assert.equal(staleCheck.status, 401);
        assert.deepEqual(staleCheck.body, {
          error: {
            type: "authentication_error",
            message: "Model gateway authentication required.",
          },
        });
        assert.equal(peerMetrics.closeCount, 0);

        const upstreamBeforeContinue = h.upstreamHits.length;
        const runtimeB = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
          initialNativeThreadId: "native-omo-main-jsonl",
        });
        yield* runtimeB.resumeThread({
          providerThread: main.providerThread,
          threadId: main.appThread.id,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtimeB, 2);

        assert.equal(mainMetrics.closeCount, 1);
        assert.equal(mainMetrics.openCount, 2);
        assert.notEqual(mainMetrics.tokensAtOpen[1], tokenA);
        assert.deepEqual(mainMetrics.resumedThreads.at(-1), {
          nativeThreadId: "native-omo-main-jsonl",
          cwd: worktree,
          model: "gpt-6.1-sol",
          thinking: "high",
        });
        assert.deepEqual(h.upstreamHits.slice(upstreamBeforeContinue), [
          {
            url: "https://service-b.example/v1/chat/completions",
            auth: "Bearer upstream-key-b",
          },
        ]);

        const peerReopened = yield* h.manager.open({
          threadId: peer.appThread.id,
          providerSessionId: peer.providerSessionId,
          modelSelection: peer.selection,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: peerWorktree,
          },
        });
        assert.strictEqual(peerReopened, peerRuntime);
        assert.equal(peerMetrics.openCount, 1);
        assert.equal(peerMetrics.closeCount, 0);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rotates session runtime across disable->enable while keeping live sessions across unrelated updates",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        const h = yield* buildCredentialRotationHarness();
        const main = yield* h.createThreadFixture({
          threadId: ThreadId.make("thread-disable-enable"),
          instanceId: INSTANCE_MAIN,
          cwd: worktree,
          nativeThreadId: "native-disable-enable",
        });

        const runtime1 = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtime1, 1);
        const metrics = h.metricsFor(INSTANCE_MAIN);
        const token1 = metrics.tokensAtOpen[0];

        const unrelatedService = ModelServiceId.make("service-unrelated");
        yield* h.serverSettings.updateSettings({
          promptSuggestionsEnabled: true,
          modelServices: {
            [unrelatedService]: {
              name: "Unrelated",
              revision: 0,
              baseUrl: "https://unrelated.example",
              headers: {},
              protocols: ["openai-chat"],
              models: [{ id: "m1", capabilities: null }],
              enabled: true,
              recovery: DEFAULT_MODEL_SERVICE_RECOVERY,
            },
          },
        });
        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            displayName: "Renamed OMO",
            enabled: true,
            modelService: { serviceId: SERVICE_A, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });
        yield* h.reconcileNow;

        const reused = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        assert.strictEqual(reused, runtime1);
        assert.equal(metrics.openCount, 1);
        assert.equal(metrics.closeCount, 0);

        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            enabled: false,
            modelService: { serviceId: SERVICE_A, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });
        yield* h.reconcileNow;
        assert.equal((yield* invokeGatewayModels(h.gateway, token1)).status, 401);

        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            enabled: true,
            modelService: { serviceId: SERVICE_A, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });

        const runtime2 = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
          initialNativeThreadId: "native-disable-enable",
        });
        yield* runtime2.resumeThread({
          providerThread: main.providerThread,
          threadId: main.appThread.id,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtime2, 2);

        assert.equal(metrics.openCount, 2);
        assert.equal(metrics.closeCount, 1);
        assert.notEqual(metrics.tokensAtOpen[1], token1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "serializes concurrent turn open behind an in-flight settings rebind without stale token or lookup failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        let pauseNextMainCreate = false;
        const createEntered = yield* Deferred.make<void>();
        const releaseCreate = yield* Deferred.make<void>();

        const h = yield* buildCredentialRotationHarness({
          onDriverCreate: (id) =>
            id === INSTANCE_MAIN && pauseNextMainCreate
              ? Deferred.succeed(createEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCreate)),
                )
              : Effect.void,
        });
        const main = yield* h.createThreadFixture({
          threadId: ThreadId.make("thread-concurrent-rebind"),
          instanceId: INSTANCE_MAIN,
          cwd: worktree,
          nativeThreadId: "native-concurrent",
        });

        const runtimeA = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtimeA, 1);

        pauseNextMainCreate = true;
        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            enabled: true,
            modelService: { serviceId: SERVICE_B, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });

        const reconcileFiber = yield* h.reconcileNow.pipe(Effect.forkChild);
        yield* Deferred.await(createEntered);

        const openAndContinueFiber = yield* Effect.gen(function* () {
          const runtimeB = yield* h.manager.open({
            threadId: main.appThread.id,
            providerSessionId: main.providerSessionId,
            modelSelection: main.selection,
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: worktree,
            },
          });
          yield* main.runTurn(runtimeB, 2);
          return runtimeB;
        }).pipe(Effect.forkChild);

        yield* Deferred.succeed(releaseCreate, undefined);
        yield* Fiber.join(reconcileFiber);
        const runtimeB = yield* Fiber.join(openAndContinueFiber);

        assert.notStrictEqual(runtimeB, runtimeA);
        assert.equal(h.metricsFor(INSTANCE_MAIN).openCount, 2);
        assert.equal(h.upstreamHits.at(-1)?.url, "https://service-b.example/v1/chat/completions");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "replays an unconsumed buffered background wake onto the replacement runtime after credential rotation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const worktree = yield* fs.makeTempDirectoryScoped();
        const h = yield* buildCredentialRotationHarness();
        const main = yield* h.createThreadFixture({
          threadId: ThreadId.make("thread-wake-rebind"),
          instanceId: INSTANCE_MAIN,
          cwd: worktree,
          nativeThreadId: "native-wake-jsonl",
        });

        const runtimeA = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtimeA, 1);

        const metrics = h.metricsFor(INSTANCE_MAIN);
        metrics.pendingWakeOnActiveRuntime = true;

        yield* h.serverSettings.updateProviderInstance({
          operation: "upsert",
          instanceId: INSTANCE_MAIN,
          instance: {
            driver: OMO_DRIVER,
            enabled: true,
            modelService: { serviceId: SERVICE_B, modelIds: [], defaultModel: "gpt-6.1-sol" },
            config: {},
          },
        });

        const runtimeB = yield* h.manager.open({
          threadId: main.appThread.id,
          providerSessionId: main.providerSessionId,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
          initialNativeThreadId: "native-wake-jsonl",
        });
        yield* runtimeB.resumeThread({
          providerThread: main.providerThread,
          threadId: main.appThread.id,
          modelSelection: main.selection,
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: worktree },
        });
        yield* main.runTurn(runtimeB, 2, "provider");
        yield* main.runTurn(runtimeB, 3, "provider");

        assert.equal(metrics.openCount, 2);
        assert.equal(metrics.closeCount, 1);
        assert.deepEqual(metrics.turnCreationSources, ["web", "server", "provider"]);
        assert.deepEqual(metrics.turnGatewayStatuses, [200, 200, 200]);
        assert.equal(h.upstreamHits.at(-1)?.url, "https://service-b.example/v1/chat/completions");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
