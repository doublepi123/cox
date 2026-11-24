import type { OrchestrationV2AppThread, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as TaskFolders from "./TaskFolders.ts";
import { withWorkspaceLease } from "./workspaceLease.ts";

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

export class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

export const makeRestoreMissingWorktree = Effect.fn("makeRestoreMissingWorktree")(function* (
  findWorkspaceRoot: (
    projectId: OrchestrationV2AppThread["projectId"],
  ) => Effect.Effect<string | undefined>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const taskFolders = yield* TaskFolders.TaskFolders;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

  const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(function* (
    cwd: string,
  ) {
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: "origin",
      });
      return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });

  const recreateMissingWorktree = Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
    function* (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
    }) {
      const { cwd, worktreePath, branch } = input;
      yield* gitWorkflow.pruneWorktrees({ cwd });
      const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
      if (localBranchNames.includes(branch)) {
        yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
        return;
      }
      const pushedRef = `refs/remotes/origin/${branch}`;
      if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: pushedRef,
          newRefName: branch,
          path: worktreePath,
        });
        return;
      }
      const base = yield* resolveRecreateBase(cwd);
      if (base === null) {
        return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: base.refName,
        newRefName: branch,
        ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
        path: worktreePath,
      });
    },
  );

  return Effect.fn("restoreMissingWorktree")(function* (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "worktreePath" | "branch">,
  ) {
    const { worktreePath, branch } = thread;
    if (worktreePath === null || branch === null) return;
    const taskFolder = yield* taskFolders
      .find(worktreePath)
      .pipe(Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })));
    if (taskFolder !== null) {
      const existed = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
      let recreated = false;
      yield* taskFolders
        .restore({
          taskFolder,
          branch,
          recreate: (checkout) =>
            recreateMissingWorktree({
              cwd: checkout.repositoryPath,
              worktreePath: checkout.worktreePath,
              branch,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  recreated = true;
                }),
              ),
            ),
        })
        .pipe(
          Effect.mapError((cause) => new WorktreeRecreateError({ worktreePath, branch, cause })),
        );
      return recreated || !existed ? worktreePath : undefined;
    }
    const exists = yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true));
    if (exists || !(yield* isManagedWorktreePath(worktreePath))) return;
    const cwd = yield* findWorkspaceRoot(thread.projectId);
    if (cwd === undefined) return;
    yield* recreateMissingWorktree({ cwd, worktreePath, branch }).pipe(
      Effect.mapError((cause) =>
        cause._tag === "WorktreeRecreateNoBaseError"
          ? cause
          : new WorktreeRecreateError({ worktreePath, branch, cause }),
      ),
    );
    return worktreePath;
  });
});

export class ThreadWorktreeRestore extends Context.Service<
  ThreadWorktreeRestore,
  {
    readonly restore: (
      thread: Pick<OrchestrationV2AppThread, "id" | "projectId" | "worktreePath" | "branch">,
    ) => Effect.Effect<void, WorktreeRecreateError | WorktreeRecreateNoBaseError>;
    readonly takeRecreated: (threadId: ThreadId) => Effect.Effect<string | undefined>;
  }
>()("cox/workspace/restoreMissingWorktree/ThreadWorktreeRestore") {}

export const layer = Layer.effect(
  ThreadWorktreeRestore,
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const restore = yield* makeRestoreMissingWorktree((projectId) =>
      projects.get(projectId).pipe(
        Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot),
        Effect.orElseSucceed(() => undefined),
      ),
    );
    const recreated = new Map<ThreadId, string>();
    return {
      restore: Effect.fn("ThreadWorktreeRestore.restore")(function* (thread) {
        if (thread.worktreePath === null) return;
        const result = yield* withWorkspaceLease(
          path.resolve(thread.worktreePath),
          restore(thread),
        );
        if (result !== undefined) recreated.set(thread.id, result);
      }),
      takeRecreated: Effect.fn("ThreadWorktreeRestore.takeRecreated")((threadId) =>
        Effect.sync(() => {
          const result = recreated.get(threadId);
          recreated.delete(threadId);
          return result;
        }),
      ),
    };
  }),
);
