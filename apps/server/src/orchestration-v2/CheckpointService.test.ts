import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

it.effect("cancels a slow baseline after five seconds without timing out the workspace lock", () =>
  Effect.gen(function* () {
    const runId = RunId.make("run:slow-baseline");
    const nodeId = NodeId.make("node:slow-baseline");
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:slow-baseline"),
      threadId: ThreadId.make("thread:slow-baseline"),
      runId,
      nodeId,
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:slow-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo/slow",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00Z"),
    };
    const refs = yield* Ref.make<ReadonlySet<string>>(new Set());
    const snapshots = yield* Ref.make(0);
    const cancelled = yield* Ref.make(0);
    const firstStarted = yield* Deferred.make<void>();
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: ({ checkpointRef }) =>
              Ref.get(refs).pipe(Effect.map((current) => current.has(checkpointRef))),
            captureCheckpoint: ({ checkpointRef }) =>
              Effect.gen(function* () {
                yield* Ref.update(snapshots, (count) => count + 1);
                yield* Deferred.succeed(firstStarted, undefined);
                yield* Effect.sleep("10 seconds").pipe(
                  Effect.onInterrupt(() => Ref.update(cancelled, (count) => count + 1)),
                );
                yield* Ref.update(refs, (current) => new Set([...current, checkpointRef]));
              }),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      const postTurn = yield* checkpoints
        .capture({
          scope,
          ordinalWithinScope: 1,
          runId,
          nodeId,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const waiting = yield* checkpoints
        .captureBaseline({ scope, ordinalWithinScope: 1 })
        .pipe(Effect.result, Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(postTurn)).status, "ready");
      assert.equal((yield* Fiber.join(waiting))._tag, "Success");
      const finished = yield* Deferred.make<void>();
      const slow = yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 }).pipe(
        Effect.result,
        Effect.tap(() => Deferred.succeed(finished, undefined)),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      assert.isTrue(yield* Deferred.isDone(finished), "baseline still blocks after five seconds");
      assert.equal((yield* Fiber.join(slow))._tag, "Failure");
      assert.equal(yield* Ref.get(cancelled), 1);
      assert.equal(yield* Ref.get(snapshots), 2);
      assert.equal((yield* Ref.get(refs)).size, 1);
    }).pipe(Effect.provide(layerTest));
  }),
);

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
              nodeId: scope.nodeId,
              capturedAt: scope.createdAt,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);
