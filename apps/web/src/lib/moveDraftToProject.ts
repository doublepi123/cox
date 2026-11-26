import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import {
  composerDraftHasUserContent,
  type DraftId,
  useComposerDraftStore,
} from "../composerDraftStore";
import { retargetDraftWorkspace } from "./retargetDraftWorkspace";
import { getClientSettings } from "../hooks/useSettings";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import { hasExplicitComposerModelSelection } from "./chatThreadActions";
import { readEnvironment } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveProjectDefaultProviderModelSelection } from "../providerInstances";

/**
 * Moves an unsent draft the user wrote in to `project`, keeping its content. Returns false for an
 * empty draft, which the caller should leave alone and open the project's own draft instead:
 * moving it would replace that draft and strand browser tabs on it.
 */
export function moveDraftToProject(
  draftId: DraftId,
  project: EnvironmentProject,
  logicalProjectKey?: string,
): boolean {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  const currentDraft = store.getComposerDraft(draftId);
  if (
    session === null ||
    session.promotedTo != null ||
    !composerDraftHasUserContent(currentDraft)
  ) {
    return false;
  }
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  store.setLogicalProjectDraftThreadId(
    logicalProjectKey ??
      deriveLogicalProjectKeyFromSettings(
        project,
        selectProjectGroupingSettings(getClientSettings()),
      ),
    projectRef,
    draftId,
    retargetDraftWorkspace(session, projectRef, project),
  );
  if (!hasExplicitComposerModelSelection(currentDraft)) {
    store.applyStickyState(draftId);
    const environmentConfig = readEnvironment(project.environmentId)?.serverConfig;
    const providers =
      appAtomRegistry
        .get(environmentPresentations.providersByEnvironmentAtom)
        .get(project.environmentId) ?? [];
    const environmentSettings = environmentConfig?.settings;
    const defaultSelection = environmentSettings
      ? resolveProjectSettings(environmentSettings, project.id, project).settings
          .defaultModelSelection
      : project.defaultModelSelection;
    const fallbackResolution = resolveNewThreadModelSelection({
      defaultSelection:
        defaultSelection ??
        (store.stickyActiveProvider !== null || !environmentSettings
          ? null
          : resolveProjectDefaultProviderModelSelection(
              providers,
              environmentSettings,
              project.id,
            )),
      fallbackSelection: environmentSettings?.fallbackModelSelection ?? null,
      providers,
      ...(environmentSettings ? { settings: environmentSettings } : {}),
      projectId: project.id,
      now: Date.now(),
    });
    const defaultModelSelection = fallbackResolution.fallback
      ? fallbackResolution.selection
      : defaultSelection;
    if (defaultModelSelection) {
      store.setModelSelection(draftId, defaultModelSelection, {
        replaceOptions: true,
      });
    }
  }

  return true;
}
