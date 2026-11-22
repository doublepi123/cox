import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  type ProjectFile = { readonly defaultThreadEnvMode?: "local" | "worktree" } | null;
  let completeProjectFileRead: (value: ProjectFile) => void = () => undefined;
  let projectFileRead = Promise.resolve<ProjectFile>(null);
  let draftSession = {
    envMode: "local",
    environmentId: "environment-ssh",
    projectId: "project-remote",
    worktreePath: null,
    branch: null as string | null,
  };
  let projectRemoved = false;
  let draftsWithUserText = new Set<string>();
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => ({ draftId })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      openDraftRoute === null
        ? { ...draftSession, promotedTo: null, startFromOrigin: false }
        : {
            logicalProjectKey: "remote-project",
            promotedTo: null,
            threadId: "thread-open",
            createdAt: "2026-01-01T00:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
          },
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: ProjectFile) => completeProjectFileRead(value),
    pickBranch(branch: string) {
      draftSession = { ...draftSession, branch };
    },
    removeProject() {
      projectRemoved = true;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    hasUserText: (draft: { readonly draftId?: string } | null | undefined) =>
      draft?.draftId !== undefined && draftsWithUserText.has(draft.draftId),
    giveUserText(draftId: string) {
      draftsWithUserText.add(draftId);
    },
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    openEmptyDraft(draftId: string) {
      openDraftRoute = { kind: "draft", draftId };
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      projectRemoved = false;
      draftsWithUserText = new Set();
      openDraftRoute = null;
      draftSession = {
        envMode: "local",
        environmentId: "environment-ssh",
        projectId: "project-remote",
        worktreePath: null,
        branch: null,
      };
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<ProjectFile>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "connected-environment-ids"
        ? testState.connectedEnvironmentIds
        : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react-dom", () => ({ flushSync: (update: () => void) => update() }));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: testState.hasUserText,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../providerInstances", () => ({ resolveDefaultProviderModelSelection: () => null }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
  peekT3ProjectFile: () => undefined,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProject: () => (testState.projectRemoved ? null : project),
    readProjects: () => (testState.projectRemoved ? [] : [project]),
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ getClientSettings: () => ({}) }));

import { readPendingWorkspaceDefault, useNewThreadHandler } from "./useHandleNewThread";

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it("opens the draft before the project file is read, then applies its workspace default", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ envMode: "local" }),
    );
    testState.draftStore.setDraftThreadContext.mockClear();

    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;

    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(opened?.draftId, {
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("does not return to the draft after the user navigates away", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    const pending = readPendingWorkspaceDefault(opened!.draftId);
    expect(pending).not.toBeNull();
    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pending;
    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });

  it("ignores a late default for a project that was removed", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    const pendingDefault = readPendingWorkspaceDefault(opened!.draftId);
    expect(pendingDefault).not.toBeNull();
    testState.removeProject();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingDefault;
    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("keeps a branch the user picked while the project file loaded", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    testState.draftStore.setDraftThreadContext.mockClear();

    testState.pickBranch("feature");
    expect(readPendingWorkspaceDefault(opened!.draftId)).toBeNull();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await testState.projectFileRead;

    expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
  });

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});

describe("useNewThreadHandler", () => {
  it("keeps the text of a draft that gained some while it waited", async () => {
    testState.reset(null);
    const raced = {
      draftId: "draft-raced",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-raced",
    };
    testState.draftStore.getDraftSessionByLogicalProjectKey
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(raced as never);
    testState.giveUserText("draft-raced");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-raced");
    expect(testState.draftStore.setPrompt).not.toHaveBeenCalled();
  });

  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});
