import { describe, expect, it } from "vite-plus/test";
import { DraftId } from "../composerDraftStore";
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

describe("pending draft checkouts", () => {
  it("lets a waiting send resume only after the current checkout was applied", async () => {
    const draftId = DraftId.make("draft");
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    trackPendingDraftCheckout(draftId, first.promise);
    const superseded = readPendingWorkspaceDefault(draftId);
    const isCurrent = trackPendingDraftCheckout(draftId, second.promise);
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
    const rejected = deferred<boolean>();
    trackPendingDraftCheckout(draftId, rejected.promise);
    const pending = readPendingWorkspaceDefault(draftId);
    rejected.reject(new Error("checkout failed"));
    await expect(pending).resolves.toBe(false);
    expect(readPendingWorkspaceDefault(draftId)).toBeNull();
  });
});
