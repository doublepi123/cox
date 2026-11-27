import { describe, expect, it } from "vite-plus/test";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { readPendingWorkspaceDefault, trackPendingDraftCheckout } from "./draftWorkspaceDefaults";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const project = scopeProjectRef(EnvironmentId.make("environment"), ProjectId.make("project"));

describe("pending draft checkouts", () => {
  it("lets a waiting send resume only after the current checkout was applied", async () => {
    const draftId = DraftId.make("draft");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(project), project, draftId);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    trackPendingDraftCheckout(draftId, project, first.promise);
    const superseded = readPendingWorkspaceDefault(draftId);
    const isCurrent = trackPendingDraftCheckout(draftId, project, second.promise);
    const current = readPendingWorkspaceDefault(draftId);
    expect(superseded).not.toBe(current);
    expect(isCurrent()).toBe(true);

    first.resolve(true);
    await expect(superseded).resolves.toBe(true);
    expect(readPendingWorkspaceDefault(draftId)).toBe(current);

    second.resolve(false);
    await expect(current).resolves.toBe(false);
    expect(isCurrent()).toBe(false);
    expect(readPendingWorkspaceDefault(draftId)).toBeNull();
  });

  it("reports a rejected checkout as not applied", async () => {
    const draftId = DraftId.make("draft");
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(scopedProjectKey(project), project, draftId);
    const rejected = deferred<boolean>();
    trackPendingDraftCheckout(draftId, project, rejected.promise);
    const pending = readPendingWorkspaceDefault(draftId);
    rejected.reject(new Error("checkout failed"));
    await expect(pending).resolves.toBe(false);
    expect(readPendingWorkspaceDefault(draftId)).toBeNull();
  });
});
