import type { ScopedProjectRef } from "@t3tools/contracts";
import {
  type DraftId,
  type DraftSessionState,
  type DraftThreadEnvMode,
  useComposerDraftStore,
} from "../composerDraftStore";

// Drafts that opened before their project's t3.json was read. A send waits for the file's
// workspace default unless the user has already chosen a workspace.
interface ProvisionalWorkspace {
  readonly envMode: DraftThreadEnvMode;
  readonly branch: DraftSessionState["branch"];
  readonly project: ScopedProjectRef;
}

const pendingWorkspaceDefaults = new Map<
  DraftId,
  ProvisionalWorkspace & { readonly settled: Promise<void> }
>();

function keepsProvisionalWorkspace(
  draft: DraftSessionState | null,
  provisional: ProvisionalWorkspace,
): draft is DraftSessionState {
  return (
    draft !== null &&
    draft.promotedTo == null &&
    !draft.workspaceExplicit &&
    draft.envMode === provisional.envMode &&
    draft.worktreePath === null &&
    draft.branch === provisional.branch &&
    draft.environmentId === provisional.project.environmentId &&
    draft.projectId === provisional.project.projectId
  );
}

const pendingCheckouts = new Map<DraftId, Promise<boolean>>();

/** A waiting send can resume only after the current checkout has been applied. */
export function trackPendingDraftCheckout(draftId: DraftId, checkoutReady: Promise<boolean>) {
  const isCurrent = () => pendingCheckouts.get(draftId) === settled;
  const settled: Promise<boolean> = checkoutReady
    .catch(() => false)
    .finally(() => {
      if (isCurrent()) pendingCheckouts.delete(draftId);
    });
  pendingCheckouts.set(draftId, settled);
  return isCurrent;
}

export function readPendingWorkspaceDefault(draftId: DraftId): Promise<boolean | void> | null {
  const checkout = pendingCheckouts.get(draftId);
  if (checkout) return checkout;
  const pending = pendingWorkspaceDefaults.get(draftId);
  if (pending === undefined) return null;
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  return keepsProvisionalWorkspace(draft, pending) ? pending.settled : null;
}
export function trackPendingWorkspaceDefault(
  draftId: DraftId,
  provisional: ProvisionalWorkspace,
  load: (isCurrent: () => boolean) => Promise<void>,
): void {
  const isCurrent = () =>
    pendingWorkspaceDefaults.get(draftId)?.settled === settled &&
    keepsProvisionalWorkspace(
      useComposerDraftStore.getState().getDraftSession(draftId),
      provisional,
    );
  const settled: Promise<void> = Promise.resolve()
    .then(() => load(isCurrent))
    .finally(() => {
      if (pendingWorkspaceDefaults.get(draftId)?.settled === settled) {
        pendingWorkspaceDefaults.delete(draftId);
      }
    });
  pendingWorkspaceDefaults.set(draftId, { ...provisional, settled });
}
