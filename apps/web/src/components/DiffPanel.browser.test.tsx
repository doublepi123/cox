import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  CheckpointRef,
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type ClientSettings,
  type OrchestrationGetTurnDiffResult,
  type ReviewBranchCommitsResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { type ReactNode, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render, stubGlobal } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;
type PatchAtom = Atom.Writable<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  filePatches: new Map<string, PatchAtom>(),
  requestedPaths: new Set<string>(),
  diffFilesCollapsed: false,
  diffLayout: "stacked" as ClientSettings["diffLayout"],
  codeViewMounts: 0,
  project: {
    workspaceRoot: "/project",
    repositoryIdentity: null as { rootPath: string } | null,
  },
  toolCallItem: null as unknown,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
  checkpoints: [] as unknown[],
  checkpointDiff: null as Partial<OrchestrationGetTurnDiffResult> | null,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
    branchCommits: () => state.commits,
    diffFilePatch: ({ input }: { input: { request: { file: { path: string } } } }) => {
      const path = input.request.file.path;
      state.requestedPaths.add(path);
      return state.filePatches.get(path) ?? state.patch;
    },
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => state.thread,
  useProject: () => state.project,
  useThreadCheckpointSummaries: () => state.checkpoints,
  useQuietThreadVisibleTurnItems: () => [],
  useQuietThreadProjection: () => null,
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
  filesystemEnvironment: {},
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => state.threadRef }));
vi.mock("~/hooks/useSettings", () => {
  const settings = () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    diffFilesCollapsed: state.diffFilesCollapsed,
    diffLayout: state.diffLayout,
  });
  return {
    useClientSettings: (select: (settings: ClientSettings) => unknown) => select(settings()),
    getClientSettings: settings,
    ensureClientSettingsHydrated: async () => {},
    updateClientSettings: async () => {},
  };
});
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: state.checkpointDiff, error: null, isPending: false }),
  useTurnItemDetail: () => ({
    data: state.toolCallItem ? { item: state.toolCallItem } : null,
    error: null,
    isPending: false,
  }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));
vi.mock("./diffs/StyledDiffCodeView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./diffs/StyledDiffCodeView")>();
  const { createElement, useEffect } = await import("react");
  return {
    ...actual,
    StyledDiffCodeView: (props: Parameters<typeof actual.StyledDiffCodeView>[0]) => {
      useEffect(() => {
        state.codeViewMounts += 1;
      }, []);
      return createElement(actual.StyledDiffCodeView, props);
    },
  };
});

import DiffPanel from "./DiffPanel";
import { ChatRightPanel } from "./chat/ChatRightPanel";
import { PreviewPanelShell, type PreviewPanelMode } from "./preview/PreviewPanelShell";
import type { PreviewPanelInlineSize } from "~/hooks/usePreviewPanelInlineSize";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

type TestRightPanelTabsProps = {
  readonly mode: PreviewPanelMode;
  readonly maximized?: boolean | undefined;
  readonly open?: boolean | undefined;
  readonly inlineSize: PreviewPanelInlineSize;
  readonly layoutControls: ReactNode;
  readonly children: ReactNode;
};

vi.mock("./RightPanelTabs", () => ({
  RightPanelTabs: (props: TestRightPanelTabsProps) => (
    <PreviewPanelShell
      mode={props.mode}
      maximized={props.maximized ?? false}
      open={props.open ?? true}
      inlineSize={props.inlineSize}
    >
      <div className="flex min-h-12 shrink-0 items-center justify-end">{props.layoutControls}</div>
      {props.children}
    </PreviewPanelShell>
  ),
}));

const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: "",
        diffHash: "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null) {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      keepSelectionOnOpenThreadKey: null,
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  };
  reset();
  localStorage.removeItem("t3code.diffFileTreeOpen");
  state.filePatches.clear();
  state.requestedPaths.clear();
  state.diffFilesCollapsed = false;
  state.diffLayout = DEFAULT_CLIENT_SETTINGS.diffLayout;
  state.codeViewMounts = 0;
  state.project = { workspaceRoot: "/project", repositoryIdentity: null };
  state.toolCallItem = null;
  state.checkpoints = [];
  state.checkpointDiff = null;
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.patch = patch;
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

it.each([false, true])(
  "expands an unloaded file on the first click with default collapse %s",
  async (collapsed) => {
    using context = setup("origin/orphan");
    state.diffFilesCollapsed = collapsed;
    const path = `pending-${collapsed}.txt`;
    const metadata = preview();
    const source = {
      ...metadata.sources[0]!,
      files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
    };
    state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
        </div>
      </RegistryContext.Provider>,
    );
    const toggle = screen.getByRole("button", { name: `Expand ${path}`, exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    act(() =>
      context.registry.set(
        context.patch,
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
        }),
      ),
    );
    const loadedToggle = screen.getByRole("button", { name: `Collapse ${path}`, exact: true });
    await expect.element(loadedToggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("after", { exact: true })).toBeVisible();
    await userEvent.click(loadedToggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  },
);

function setupFiles(paths: string[]) {
  const context = setup("origin/orphan");
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 1 })),
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  for (const path of paths) {
    state.filePatches.set(
      path,
      Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(AsyncResult.initial()),
    );
  }
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  return {
    ...context,
    load(path: string, lineCount = 1) {
      const before = Array.from({ length: lineCount }, (_, index) => `-before-${path}-${index}`);
      const after = Array.from({ length: lineCount }, (_, index) => `+after-${path}-${index}`);
      return act(() =>
        context.registry.set(
          state.filePatches.get(path)!,
          AsyncResult.success({
            ...source,
            files: source.files.filter((file) => file.path === path),
            diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${lineCount} +1,${lineCount} @@\n${[...before, ...after].join("\n")}\n`,
          }),
        ),
      );
    },
  };
}

async function viewportScope(width: number, height: number) {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return {
    [Symbol.asyncDispose]: () => page.viewport(previous.width, previous.height),
  };
}

function coarsePointerScope() {
  const matchMedia = window.matchMedia.bind(window);
  return stubGlobal("matchMedia", (query: string) => {
    const media = matchMedia(query);
    if (query === "(pointer: coarse)") {
      Object.defineProperty(media, "matches", { value: true });
    }
    return media;
  });
}

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

function ChatDiffPanel({
  context,
  maximized = false,
}: {
  readonly context: ReturnType<typeof setupFiles>;
  readonly maximized?: boolean;
}) {
  const [workspaceLayoutElement, setWorkspaceLayoutElement] = useState<HTMLDivElement | null>(null);
  return (
    <RegistryContext.Provider value={context.registry}>
      <div
        ref={setWorkspaceLayoutElement}
        className="flex h-[800px] w-full min-w-0 overflow-hidden"
      >
        <div className="min-w-0 flex-1">Chat</div>
        <ChatRightPanel
          sheet={false}
          maximized={maximized}
          workspaceLayoutElement={workspaceLayoutElement}
          widthStorageKey="test-mobile-diff-panel-width"
          sheetAnimationDurationMs={0}
          onCloseSheet={() => {}}
          open
          keybindings={[]}
          getShortcutContext={() => shortcutContext}
          layoutControls={null}
          surfaces={[{ id: "diff", kind: "diff" }]}
          environmentId={context.threadRef.environmentId}
          activeSurfaceId="diff"
          pendingSurfaceIds={new Set()}
          previewSessions={{}}
          terminalLabelsById={new Map()}
          onActivate={() => {}}
          onCloseSurface={() => {}}
          onCloseSelectedSurfaces={() => {}}
          onCloseOtherSurfaces={() => {}}
          onCloseSurfacesToRight={() => {}}
          onCloseAllSurfaces={() => {}}
          onCopyFilePath={() => {}}
          onAddBrowser={() => {}}
          onAddBrowserInProfile={() => {}}
          onAddTerminal={() => {}}
          onAddDiff={() => {}}
          onAddFiles={() => {}}
          onAddPullRequest={() => {}}
          onAddPullRequests={() => {}}
          browserAvailable={false}
          terminalAvailable={false}
          diffAvailable
          filesAvailable={false}
          pullRequestAvailable={false}
          pullRequestsAvailable={false}
          sideChatAvailable={false}
        >
          <DiffPanel
            mode="embedded"
            composerDraftTarget={context.threadRef}
            workspaceMutationId={null}
            visible
          />
        </ChatRightPanel>
      </div>
    </RegistryContext.Provider>
  );
}

function previewPanel() {
  const element = document.querySelector("[data-preview-panel-mode]");
  if (!(element instanceof HTMLElement)) throw new Error("Missing preview panel");
  return element;
}

it("defaults to an overflow-free unified diff with touch targets at 360px", async () => {
  await using _viewport = await viewportScope(360, 800);
  using _pointer = coarsePointerScope();
  using context = setupFiles(["mobile.ts"]);
  state.diffLayout = "split";
  await using _screen = await render(<ChatDiffPanel context={context} maximized />);
  await context.load("mobile.ts");
  await expect.element(page.getByText("after-mobile.ts-0", { exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Stacked diff view", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await vi.waitFor(() => {
    const diff = document
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector("[data-diff-type]");
    expect(diff?.getAttribute("data-diff-type")).toBe("single");
  });
  const close = page.getByRole("button", { name: "Close panel", exact: true }).element();
  const closeRect = close.getBoundingClientRect();
  expect(closeRect.width).toBeGreaterThanOrEqual(44);
  expect(closeRect.height).toBeGreaterThanOrEqual(44);
  const collapse = page
    .getByRole("button", { name: "Collapse mobile.ts", exact: true })
    .element()
    .getBoundingClientRect();
  expect(collapse.width).toBeGreaterThanOrEqual(44);
  expect(collapse.height).toBeGreaterThanOrEqual(44);
  expect(previewPanel().getBoundingClientRect().width).toBe(360);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});

it("switches the active file from the mobile file selector", async () => {
  await using _viewport = await viewportScope(360, 800);
  using _pointer = coarsePointerScope();
  using context = setupFiles(["first.ts", "second.ts"]);
  state.diffFilesCollapsed = true;
  await using _screen = await render(<ChatDiffPanel context={context} />);
  await context.load("first.ts");
  await context.load("second.ts");
  const selector = page.getByRole("combobox", { name: "Jump to changed file", exact: true });
  await expect.element(selector).toHaveValue("first.ts");
  await expect
    .element(page.getByRole("button", { name: "Expand second.ts", exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  await selector.selectOptions("second.ts");
  await expect.element(selector).toHaveValue("second.ts");
  await expect
    .element(page.getByRole("button", { name: "Collapse second.ts", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(page.getByText("after-second.ts-0", { exact: true })).toBeVisible();
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
});

it("moves between resizable inline and full-width sheet layouts across resizes", async () => {
  await using _viewport = await viewportScope(1280, 800);
  using context = setupFiles(["resize.ts"]);
  state.diffLayout = "split";
  await using _screen = await render(<ChatDiffPanel context={context} />);
  await context.load("resize.ts");
  await expect.element(page.getByText("after-resize.ts-0", { exact: true })).toBeVisible();
  expect(previewPanel().dataset.previewPanelMode).toBe("inline");
  expect(previewPanel().getBoundingClientRect().width).toBeGreaterThan(360);
  await expect
    .element(page.getByRole("button", { name: "Split diff view", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await page.viewport(360, 800);
  await expect.element(page.getByRole("dialog")).toBeVisible();
  await vi.waitFor(() => {
    expect(previewPanel().dataset.previewPanelMode).toBe("sheet");
    expect(previewPanel().getBoundingClientRect().width).toBe(360);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  });
  await expect
    .element(page.getByRole("button", { name: "Stacked diff view", exact: true }))
    .toHaveAttribute("aria-pressed", "true");

  await page.viewport(1280, 800);
  await vi.waitFor(() => {
    expect(previewPanel().dataset.previewPanelMode).toBe("inline");
    expect(previewPanel().getBoundingClientRect().width).toBeGreaterThan(360);
  });
  await expect
    .element(page.getByRole("button", { name: "Split diff view", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});

it("loads deferred patches in batches when the footer is reached", async () => {
  const paths = Array.from({ length: 9 }, (_, index) => `file-${index + 1}.txt`);
  using context = setupFiles(paths);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  expect([...state.requestedPaths]).toEqual(paths.slice(0, 4));
  for (const path of paths.slice(0, 4)) await context.load(path, 80);
  await expect
    .element(screen.getByRole("button", { name: "Collapse file-1.txt", exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  expect([...state.requestedPaths]).toEqual(paths.slice(0, 4));
  const footer = screen.getByRole("status", { name: "Loading diff…" });
  footer.element().scrollIntoView({ block: "end" });
  await vi.waitFor(() => expect([...state.requestedPaths]).toEqual(paths.slice(0, 8)));
  for (const path of paths.slice(4, 8)) await context.load(path);
  footer.element().scrollIntoView({ block: "end" });
  await vi.waitFor(() => expect([...state.requestedPaths]).toEqual(paths));
  await context.load(paths[8]!);
  await expect.element(footer).not.toBeInTheDocument();
  await expect.element(screen.getByText("after-file-9.txt-0", { exact: true })).toBeVisible();
});

it("selects an unloaded file by path from the tree without requesting the intervening files", async () => {
  await using _viewport = await viewportScope(1280, 800);
  const paths = Array.from({ length: 6 }, (_, index) => `tree-${index + 1}.txt`);
  using context = setupFiles(paths);
  state.diffFilesCollapsed = true;
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  expect([...state.requestedPaths]).toEqual(paths.slice(0, 4));
  await userEvent.click(screen.getByRole("button", { name: "Show file tree", exact: true }));
  await userEvent.click(screen.getByRole("treeitem", { name: paths[5]!, exact: true }));
  await vi.waitFor(() =>
    expect([...state.requestedPaths]).toEqual([...paths.slice(0, 4), paths[5]!]),
  );
  await context.load(paths[5]!);
  const toggle = screen.getByRole("button", { name: `Collapse ${paths[5]}`, exact: true });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("after-tree-6.txt-0", { exact: true })).toBeVisible();
  await userEvent.click(toggle);
  await expect
    .element(screen.getByRole("button", { name: `Expand ${paths[5]}`, exact: true }))
    .toHaveAttribute("aria-expanded", "false");
  expect(state.requestedPaths.has(paths[4]!)).toBe(false);
});

it("shows a turn's repositories in a folder that is not a Git repository", async () => {
  using context = setup("origin/orphan");
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const patch = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
  const repository = (name: string) => ({
    scopeId: CheckpointScopeId.make(`scope-${name}`),
    name,
    repositoryPath: `${cwd}/${name}`,
    cwd: `${cwd}/${name}`,
    relativePath: name,
    files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
    baselineMissing: false,
  });
  state.checkpoints = [
    {
      runId: RunId.make("run-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/root-1"),
      status: "missing",
      files: [],
      repositories: [repository("api"), repository("web")],
      assistantMessageId: null,
      completedAt: "2026-11-10T00:00:00.000Z",
    },
  ];
  state.checkpointDiff = {
    threadId: context.threadRef.threadId,
    fromTurnCount: 0,
    toTurnCount: 1,
    diff: "",
    repositories: ["api", "web"].map((name) => ({
      name,
      repositoryPath: `${cwd}/${name}`,
      relativePath: name,
      diff: patch("README.md"),
    })),
  };
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width: 390, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
        />
      </div>
    </RegistryContext.Provider>,
  );
  const api = screen.getByRole("button", { name: "Collapse api/README.md", exact: true });
  const web = screen.getByRole("button", { name: "Collapse web/README.md", exact: true });
  await expect.element(api).toBeVisible();
  await expect.element(web).toBeVisible();
  // Both pickers keep their labels in a phone-width panel.
  await expect.element(screen.getByText("Latest turn", { exact: true })).toBeVisible();
  const picker = screen.getByRole("button", { name: "Repository: All repositories" });
  await expect.element(picker.getByText("All repositories")).toBeVisible();
  await userEvent.click(picker);
  await userEvent.click(page.getByRole("menuitemradio", { name: "web" }));
  await expect.element(web).toBeVisible();
  await expect.element(api).not.toBeInTheDocument();
});

// Paths as git's numstat reports them; the parsed patch trims the trailing space from its name.
it.each([
  { path: " leading.ts", name: " leading.ts" },
  { path: "src/trailing.ts ", name: "src/trailing.ts" },
])("reveals the turn file $path picked from the changed files", async ({ path, name }) => {
  using context = setup("origin/orphan");
  state.diffFilesCollapsed = true;
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\t\n@@ -0,0 +1 @@\n+revealed\n`,
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"), path);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await expect
    .element(screen.getByRole("button", { name: `Collapse ${name}`, exact: true }))
    .toHaveAttribute("aria-expanded", "true");
});

it("opens a tool-call diff file relative to its project workspace", async () => {
  await using _viewport = await viewportScope(1280, 800);
  using context = setup("origin/orphan");
  state.thread = { ...state.thread!, worktreePath: null };
  state.project = { workspaceRoot: "/repo/apps/web", repositoryIdentity: { rootPath: "/repo" } };
  const status = AsyncResult.getOrThrow(context.registry.get(state.status));
  state.status = Atom.make(
    AsyncResult.success({ ...status, workingTree: { ...status.workingTree, rootPath: "/repo" } }),
  );
  state.toolCallItem = {
    type: "file_change",
    fileName: "src/a.ts",
    diffStr: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-before\n+after\n",
  };
  useDiffPanelStore.getState().selectToolCall(context.threadRef, {
    threadId: context.threadRef.threadId,
    itemId: TurnItemId.make("edit"),
    revision: "1",
  });
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByText("src/a.ts", { exact: true }));
  await vi.waitFor(() =>
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
    ).toMatchObject({ activeSurfaceId: "file:src/a.ts" }),
  );
});

it("reuses the mounted code view when collapsing and expanding all files", async () => {
  using context = setupFiles(["mount.ts"]);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await context.load("mount.ts");
  await expect.element(screen.getByText("after-mount.ts-0", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(state.codeViewMounts).toBeGreaterThan(0));
  const mounts = state.codeViewMounts;

  await userEvent.click(screen.getByRole("button", { name: "Collapse all files", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Expand all files", exact: true }))
    .toBeVisible();
  expect(state.codeViewMounts).toBe(mounts);

  await userEvent.click(screen.getByRole("button", { name: "Expand all files", exact: true }));
  await expect
    .element(screen.getByRole("button", { name: "Collapse all files", exact: true }))
    .toBeVisible();
  expect(state.codeViewMounts).toBe(mounts);
});

it("keeps repeated diff blocks independent when surrounding content changes", async () => {
  using context = setup("origin/orphan");
  state.thread = { ...state.thread!, worktreePath: null };
  const patch = (blocks: [string, string][]) =>
    blocks
      .map(([path, content]) =>
        [
          `diff --git a/${path} b/${path}`,
          `--- a/${path}`,
          `+++ b/${path}`,
          "@@ -1 +1 @@",
          "-before",
          `+${content}`,
          "",
        ].join("\n"),
      )
      .join("");
  state.toolCallItem = {
    type: "file_change",
    fileName: "same.ts",
    diffStr: patch([
      ["same.ts", "first"],
      ["same.ts", "second"],
      ["same.ts", "second"],
    ]),
  };
  useDiffPanelStore.getState().selectToolCall(context.threadRef, {
    threadId: context.threadRef.threadId,
    itemId: TurnItemId.make("repeated"),
    revision: "1",
  });
  const panel = () => (
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>
  );
  await using screen = await render(panel());
  const blocks = () => [...screen.container.querySelectorAll("diffs-container")];
  const body = (index: number) => blocks()[index]?.shadowRoot?.querySelector("[data-diff]");
  const expanded = () => blocks().map((_, index) => body(index) != null);
  const fileKey = (index: number) =>
    blocks()[index]?.querySelector("[data-diff-file-key]")?.getAttribute("data-diff-file-key");
  const clickHeader = async (index: number) => {
    const header = blocks()[index]?.shadowRoot?.querySelector("[data-diffs-header]");
    if (!header) throw new Error(`Missing diff header ${String(index)}`);
    await act(async () =>
      header.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })),
    );
  };
  await vi.waitFor(() => {
    expect(blocks()).toHaveLength(3);
    expect(expanded()).toEqual([true, true, true]);
  });
  await vi.waitFor(() => {
    expect(body(0)?.textContent).toContain("first");
    expect(body(1)?.textContent).toContain("second");
    expect(body(2)?.textContent).toContain("second");
  });

  await clickHeader(1);
  await vi.waitFor(() => expect(expanded()).toEqual([true, false, true]));
  const collapsedFileKey = fileKey(1);
  if (!collapsedFileKey) throw new Error("Missing collapsed diff file key");
  state.toolCallItem = {
    type: "file_change",
    fileName: "same.ts",
    diffStr: patch([
      ["unrelated.ts", "new"],
      ["same.ts", "first"],
      ["same.ts", "updated second"],
      ["same.ts", "second"],
    ]),
  };
  await screen.rerender(panel());
  await vi.waitFor(() => expect(blocks()).toHaveLength(4));
  const collapsedIndex = blocks().findIndex((_, index) => fileKey(index) === collapsedFileKey);
  expect(collapsedIndex).toBeGreaterThanOrEqual(0);
  expect(expanded()).toEqual(blocks().map((_, index) => index !== collapsedIndex));
  await clickHeader(collapsedIndex);
  await vi.waitFor(() => {
    expect(expanded()).toEqual([true, true, true, true]);
    expect(body(collapsedIndex)?.textContent).toContain("updated second");
  });
});

it("explains a branch diff whose only changes are hidden test files", async () => {
  using context = setup("origin/orphan");
  using _hideTestFiles = {
    [Symbol.dispose]() {
      window.localStorage.removeItem("t3code.diffHideTestFiles");
    },
  };
  const path = "math.test.ts";
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 0 }],
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await vi.waitFor(() =>
    expect(screen.getByText(path, { exact: true }).all().length).toBeGreaterThan(0),
  );
  await userEvent.click(screen.getByRole("button", { name: "Hide test files", exact: true }));
  await expect.element(screen.getByText(path, { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("1 test file hidden", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show test files", exact: true }));
  await vi.waitFor(() =>
    expect(screen.getByText(path, { exact: true }).all().length).toBeGreaterThan(0),
  );
});

it("opens a repository-relative file from a nested project without a remote", async () => {
  await using _viewport = await viewportScope(1280, 800);
  const path = "project/back\\slash.txt";
  using context = setupFiles([path]);
  state.thread = { ...state.thread!, worktreePath: null };
  const status = AsyncResult.getOrThrow(context.registry.get(state.status));
  state.status = Atom.make(
    AsyncResult.success({ ...status, workingTree: { ...status.workingTree, rootPath: "/" } }),
  );
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await context.load(path);
  await userEvent.click(screen.getByText(path, { exact: true }));
  await vi.waitFor(() =>
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
    ).toMatchObject({ activeSurfaceId: "file:back\\slash.txt" }),
  );
});

it("says a turn diff cut off at the server's size limit is incomplete", async () => {
  using context = setup("origin/orphan");
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: "diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -0,0 +1 @@\n+visible\n\n[truncated]",
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"));
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByRole("option", { name: "first.txt" })).toBeInTheDocument();
  await expect
    .element(screen.getByText("This preview exceeds the size limit. Changes shown are incomplete."))
    .toBeVisible();
});
