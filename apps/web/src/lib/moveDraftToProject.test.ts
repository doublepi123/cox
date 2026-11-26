import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { moveDraftToProject } from "./moveDraftToProject";
import { readPendingWorkspaceDefault } from "../hooks/useHandleNewThread";
import type { T3ProjectFile } from "@t3tools/contracts";

const destination = vi.hoisted(() => ({
  project: null as EnvironmentProject | null,
  listeners: new Set<() => void>(),
  read: vi.fn<
    (
      environment: EnvironmentId,
      root: string,
      signal?: AbortSignal,
    ) => Promise<T3ProjectFile | null>
  >(),
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  readEnvironment: (() =>
    destination.project ? { connection: { phase: "connected" } } : null) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readProject: () => destination.project,
  subscribeProjects: (listener) => {
    const call = () => listener(destination.project ? [destination.project] : []);
    destination.listeners.add(call);
    return () => {
      destination.listeners.delete(call);
    };
  },
}));
vi.mock(import("./t3ProjectFileDefaults"), () => ({
  peekT3ProjectFile: () => undefined,
  readT3ProjectFile: destination.read,
}));

const environmentId = EnvironmentId.make("environment-local");
const draftId = DraftId.make("draft-1");

function makeProject(name: string): EnvironmentProject {
  return {
    id: ProjectId.make(name),
    environmentId,
    title: name,
    workspaceRoot: `/work/${name}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    scripts: [],
  };
}

const current = makeProject("current");
const added = makeProject("added");
const currentRef = scopeProjectRef(environmentId, current.id);
const addedRef = scopeProjectRef(environmentId, added.id);

beforeEach(() => {
  destination.project = null;
  destination.listeners.clear();
  destination.read.mockReset();
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  useComposerDraftStore.getState().setProjectDraftThreadId(currentRef, draftId);
});

describe("moveDraftToProject", () => {
  it("moves a draft the user wrote in, leaving no draft behind in its old project", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "Plan the next project");

    expect(moveDraftToProject(draftId, added)).toBe(true);

    expect(store.getDraftSessionByProjectRef(addedRef)?.draftId).toBe(draftId);
    expect(store.getDraftSessionByProjectRef(currentRef)).toBeNull();
    expect(store.getComposerDraft(draftId)?.prompt).toBe("Plan the next project");
  });

  it("leaves an empty draft in its project", () => {
    expect(moveDraftToProject(draftId, added)).toBe(false);

    const store = useComposerDraftStore.getState();
    expect(store.getDraftSessionByProjectRef(currentRef)?.draftId).toBe(draftId);
    expect(store.getDraftSessionByProjectRef(addedRef)).toBeNull();
  });

  it.each([false, true])(
    "uses the destination workspace default unless explicitly chosen (%s)",
    (explicit) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(draftId, "Plan the next project");
      store.setDraftThreadContext(draftId, { envMode: "local", workspaceExplicit: explicit });
      expect(moveDraftToProject(draftId, { ...added, defaultThreadEnvMode: "worktree" })).toBe(
        true,
      );
      expect(store.getDraftSession(draftId)?.envMode).toBe(explicit ? "local" : "worktree");
    },
  );

  it.each(["moved", "deleted"] as const)(
    "checks a destination that was %s while reading its default",
    async (change) => {
      const store = useComposerDraftStore.getState();
      store.setPrompt(draftId, "Keep this prompt");
      destination.project = added;
      destination.read.mockImplementation((_environment, root, signal) =>
        root === "/work/moved"
          ? Promise.resolve({ defaultThreadEnvMode: "worktree" })
          : new Promise((resolve) => {
              signal?.addEventListener("abort", () => resolve(null), { once: true });
            }),
      );
      expect(moveDraftToProject(draftId, added)).toBe(true);
      const load = readPendingWorkspaceDefault(draftId);
      expect(load).not.toBeNull();
      await Promise.resolve();
      destination.project = change === "moved" ? { ...added, workspaceRoot: "/work/moved" } : null;
      for (const listener of destination.listeners) listener();
      await load;
      expect(destination.read).toHaveBeenCalledTimes(change === "moved" ? 2 : 1);
      expect(store.getDraftSession(draftId)?.envMode).toBe(
        change === "moved" ? "worktree" : "local",
      );
      expect(store.getComposerDraft(draftId)?.prompt).toBe("Keep this prompt");
      expect(destination.listeners.size).toBe(0);
    },
  );
});
