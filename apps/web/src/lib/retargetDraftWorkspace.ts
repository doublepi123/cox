import {
  DEFAULT_SERVER_SETTINGS,
  type ScopedProjectRef,
  type T3ProjectFile,
} from "@t3tools/contracts";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type DraftId, type DraftSessionState, useComposerDraftStore } from "../composerDraftStore";
import { trackPendingWorkspaceDefault } from "./draftWorkspaceDefaults";
import { flushSync } from "react-dom";
import { readProject, readThreadShells, subscribeProjects } from "../state/entities";
import { readEnvironment } from "../state/environments";
import { readUnloadedThreadCount } from "../state/olderSettledShelf";
import { resolveNewDraftStartFromOrigin } from "./chatThreadActions";
import { peekT3ProjectFile, readT3ProjectFile } from "./t3ProjectFileDefaults";

function workspaceSettings(projectRef: ScopedProjectRef) {
  const serverConfig = readEnvironment(projectRef.environmentId)?.serverConfig;
  return { serverConfig, settings: serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS };
}

function shouldReadProjectFileDefault(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
): boolean {
  const { settings } = workspaceSettings(projectRef);
  return (
    resolveProjectSettings(settings, projectRef.projectId, project).settings
      .defaultThreadEnvMode === null &&
    readEnvironment(projectRef.environmentId)?.connection.phase === "connected"
  );
}

function newThreadWorkspace(
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
  projectFile: T3ProjectFile | null,
) {
  const { serverConfig, settings } = workspaceSettings(projectRef);
  const projectSettings = resolveProjectSettings(
    settings,
    projectRef.projectId,
    project,
    projectFile,
  );
  const envMode = resolveNewThreadEnvMode({
    projectSettings,
    workspaceRoot: project.workspaceRoot,
    newProjectsRoot: serverConfig?.newProjectsRoot,
    projectHasThreads:
      readThreadShells().some(
        (thread) =>
          thread.environmentId === projectRef.environmentId &&
          thread.projectId === projectRef.projectId,
      ) ||
      readUnloadedThreadCount(
        [{ environmentId: projectRef.environmentId, id: projectRef.projectId }],
        [],
      ) > 0,
  });
  return {
    envMode,
    startFromOrigin: resolveNewDraftStartFromOrigin({
      envMode,
      newWorktreesStartFromOrigin: projectSettings.settings.newWorktreesStartFromOrigin,
    }),
  };
}

/**
 * The workspace for a draft moving to another project or machine: the default a new thread
 * there starts with, unless the user chose one, which carries over.
 */
export function retargetDraftWorkspace(
  draft: Pick<DraftSessionState, "workspaceExplicit" | "worktreePath">,
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
): { envMode?: DraftSessionState["envMode"]; startFromOrigin?: boolean } {
  return draft.workspaceExplicit || draft.worktreePath !== null
    ? {}
    : newThreadWorkspace(
        projectRef,
        project,
        shouldReadProjectFileDefault(projectRef, project)
          ? (peekT3ProjectFile(project.environmentId, project.workspaceRoot) ?? null)
          : null,
      );
}

export function loadRetargetedDraftWorkspace(
  draftId: DraftId,
  projectRef: ScopedProjectRef,
  project: EnvironmentProject,
) {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (
    !draft ||
    draft.workspaceExplicit ||
    draft.worktreePath !== null ||
    !shouldReadProjectFileDefault(projectRef, project) ||
    peekT3ProjectFile(project.environmentId, project.workspaceRoot) !== undefined
  )
    return;
  trackPendingWorkspaceDefault(
    draftId,
    { envMode: draft.envMode, branch: draft.branch, project: projectRef },
    async (isCurrent) => {
      while (isCurrent()) {
        const currentProject = readProject(projectRef);
        if (!currentProject) return;
        const root = currentProject.workspaceRoot;
        const controller = new AbortController();
        const stopProjects = subscribeProjects(() => {
          if (readProject(projectRef)?.workspaceRoot !== root) controller.abort();
        });
        const stopDraft = useComposerDraftStore.subscribe(() => {
          if (!isCurrent()) controller.abort();
        });
        try {
          const projectFile = shouldReadProjectFileDefault(projectRef, currentProject)
            ? await readT3ProjectFile(
                project.environmentId,
                root,
                AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
              )
            : null;
          if (!isCurrent()) return;
          const destination = readProject(projectRef);
          if (!destination) return;
          if (destination.workspaceRoot !== root) continue;
          const defaults = newThreadWorkspace(projectRef, destination, projectFile);
          flushSync(() => store.setDraftThreadContext(draftId, defaults));
          return;
        } finally {
          stopDraft();
          stopProjects();
        }
      }
    },
  );
}
