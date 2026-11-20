import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { VcsStatusLocalResult } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "cox/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("polls a removed worktree as a non-repository without invoking Git or warning", () => {
    const processCalls: VcsProcess.VcsProcessInput[] = [];
    const startPoll = Deferred.makeUnsafe<void>();
    const snapshot = Deferred.makeUnsafe<VcsStatusLocalResult>();
    const pollResult = Deferred.makeUnsafe<VcsStatusLocalResult | "poll warning">();
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Warn" && [message].flat()[0] === "VCS remote status refresh failed") {
        Deferred.doneUnsafe(pollResult, Effect.succeed("poll warning"));
      }
    });
    const processLayer = Layer.effect(
      VcsProcess.VcsProcess,
      Effect.gen(function* () {
        const process = yield* VcsProcess.VcsProcess;
        return VcsProcess.VcsProcess.of({
          run: (input) => {
            processCalls.push(input);
            return process.run(input);
          },
        });
      }),
    ).pipe(Layer.provide(VcsProcess.layer));
    const broadcasterLayer = VcsStatusBroadcaster.layer.pipe(
      Layer.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(VcsDriverRegistry.layer),
          Layer.provide(GitVcsDriver.layer),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "cox-removed-wt-" })),
          Layer.provide(
            Layer.mock(GitManager.GitManager)({
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasPrimaryRemote: false,
                  isDefaultRef: false,
                  refName: "linked",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
            }),
          ),
        ),
      ),
      Layer.provide(Layer.mock(BackgroundPolicy.BackgroundPolicy)({})),
      Layer.provide(
        Layer.succeed(
          VcsStatusBroadcaster.VcsAutomaticFetchInterval,
          Deferred.await(startPoll).pipe(Effect.as(Duration.seconds(30))),
        ),
      ),
      Layer.provideMerge(processLayer),
    );

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parent = yield* fs.makeTempDirectoryScoped({ prefix: "cox-removed-wt-" });
      const repo = yield* fs.realPath(parent);
      const cwd = path.join(repo, "linked");
      const vcsProcess = yield* VcsProcess.VcsProcess;
      const git = (args: readonly string[], stdin?: string) =>
        vcsProcess.run({
          operation: "test.setupWorktree",
          command: "git",
          cwd: repo,
          args,
          ...(stdin === undefined ? {} : { stdin }),
        });
      yield* git(["init", "--template=", "-b", "main"]);
      const tree = (yield* git(["mktree"], "")).stdout.trim();
      const commit = (yield* git([
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit-tree",
        tree,
        "-m",
        "init",
      ])).stdout.trim();
      yield* git(["update-ref", "refs/heads/main", commit]);
      yield* git(["worktree", "add", "-b", "linked", cwd]);

      const broadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      yield* broadcaster.streamStatus({ cwd }).pipe(
        Stream.runForEach((event) => {
          switch (event._tag) {
            case "snapshot":
              return Deferred.succeed(snapshot, event.local);
            case "localUpdated":
              return Deferred.succeed(pollResult, event.local);
            case "remoteUpdated":
              return Effect.void;
          }
        }),
        Effect.forkScoped,
      );
      assert.include(yield* Deferred.await(snapshot), { isRepo: true, refName: "linked" });
      assert.include(
        processCalls.filter((input) => input.cwd === cwd).map((input) => input.operation),
        "GitVcsDriver.detectRepository",
      );

      yield* git(["worktree", "remove", cwd]);
      const postRemoval = processCalls.length;
      yield* Deferred.succeed(startPoll, undefined);

      assert.include(yield* Deferred.await(pollResult), {
        isRepo: false,
        refName: null,
        hasWorkingTreeChanges: false,
      });
      assert.deepStrictEqual(
        processCalls
          .slice(postRemoval)
          .filter((input) => input.cwd === cwd)
          .map((input) => input.operation),
        [],
      );
    }).pipe(Effect.provide(Layer.merge(broadcasterLayer, Logger.layer([logger]))), Effect.scoped);
  });
});
