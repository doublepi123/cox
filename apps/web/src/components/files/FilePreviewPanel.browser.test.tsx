import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import appCss from "~/index.css?inline";
import { isMacPlatform } from "~/lib/utils";
import {
  createWorkspaceFocusController,
  startWorkspaceFocus,
  workspaceAreaProps,
} from "~/lib/workspaceFocus";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
  assetUrl: { _tag: "Loading" } as import("~/assets/assetUrls").AssetUrlState,
  diffWorkersReady: true,
  assetResources: [] as Array<import("@t3tools/contracts").AssetResource>,
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: (_environmentId, resource) => {
    if (resource) state.assetResources.push(resource);
    return state.assetUrl;
  },
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
  useRenderedAppearance: () => "dark",
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./FileBrowserPanel"), () => ({
  default: () => (
    <div role="tree">
      <button type="button" role="treeitem" data-item-path="src/">
        src
      </button>
      <button type="button" role="treeitem" data-item-path="server.ts">
        server.ts
      </button>
    </div>
  ),
}));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => (
    <>{state.diffWorkersReady ? children : null}</>
  ),
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";
import { ChunkedMarkdown } from "./ChunkedMarkdown";
import { splitMarkdown } from "@t3tools/shared/markdownChunks";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.optimistic = null;
  state.diffWorkersReady = true;
  state.assetUrl = { _tag: "Loading" };
  state.assetResources = [];
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(
  truncated: boolean,
  contents = "- [ ] Keep the rest of this file\n",
  relativePath = "tasks.md",
) {
  state.file = {
    relativePath,
    contents,
    byteLength: truncated ? 1_200_000 : contents.length,
    truncated,
  };
  return filePreview(relativePath);
}

function filePreview(
  relativePath: string,
  reveal: { line: number; requestId: number } | null = null,
) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={threadRef}
      composerDraftTarget={threadRef}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={reveal?.line ?? null}
      revealRequestId={reveal?.requestId ?? 0}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={null}
    />
  );
}

function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

describe("source file focus", () => {
  it("hands panel focus to the file's editor, which owns mod+f", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const panel = () => (
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>
    );
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);

    await using screen = await render(panel());
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    expect(focus.focus("panel")).toBe(true);
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await screen.rerender(panel());
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(deepActiveElement()?.textContent).toContain("xconst server"));

    (deepActiveElement() as HTMLElement).blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));
  });

  it("focuses the editor when a file row is clicked or activated with Enter", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await using screen = await render(
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")} style={{ width: 900 }}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>,
    );
    using _focus = {
      [Symbol.dispose]: startWorkspaceFocus({ subscribe: () => () => {} } as never),
    };
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);
    // The explorer measures its parent row; a wrapper without a box would cap it at the minimum.
    await expect
      .element(screen.getByRole("separator", { name: "Resize file explorer" }))
      .toHaveAttribute("aria-valuemax", "560");
    const folderRow = screen.getByRole("treeitem", { name: "src" });
    const fileRow = screen.getByRole("treeitem", { name: "server.ts" });

    (folderRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(folderRow.element());

    await userEvent.click(fileRow);
    await vi.waitFor(editorHasFocus);

    (fileRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(editorHasFocus);
  });
});

describe("source file scroll", () => {
  it("centers a linked line in a scrolled read-only file, and again when the viewer is rebuilt", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
    // Wrapped lines of differing lengths, so the viewer estimates heights until it measures them.
    const contents = Array.from(
      { length: 140 },
      (_, i) =>
        `Line ${i + 1}. ${"Notes that wrap across the preview. ".repeat(2 + ((i * 7) % 9))}`,
    ).join("\n");
    // A file outside the workspace is read-only, which CodeView renders.
    const hostFile = (reveal: { line: number; requestId: number } | null) => {
      const relativePath = "/outside/notes.txt";
      state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
      return (
        <div style={{ height: 400, width: 500, display: "flex", flexDirection: "column" }}>
          {filePreview(relativePath, reveal)}
        </div>
      );
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");
    const row = (line: number) =>
      document.querySelector("diffs-container")?.shadowRoot?.querySelector(`[data-line="${line}"]`);
    const middle = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? (rect.top + rect.bottom) / 2 : Number.NaN;
    };
    const lineIsCentered = () =>
      expect(Math.abs(middle(row(82)) - middle(scroller()))).toBeLessThan(2);

    await using screen = await render(hostFile(null));
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(2500));
    scroller()!.scrollTop = 2100;
    await vi.waitFor(() => {
      expect(scroller()?.scrollTop).toBeGreaterThan(0);
      const firstRow = row(1);
      if (firstRow)
        expect(firstRow.getBoundingClientRect().bottom).toBeLessThan(
          scroller()!.getBoundingClientRect().top,
        );
    });

    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(lineIsCentered);

    // Starting the worker pool unmounts the viewer and mounts a new one.
    state.diffWorkersReady = false;
    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(() => expect(scroller()).toBeNull());
    state.diffWorkersReady = true;
    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(lineIsCentered);
  });

  it("returns a file tab to where it was scrolled after another file was shown", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const sourceFile = (relativePath: string, lines: number) => {
      const contents = Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join("\n");
      state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
      // The app mounts under StrictMode, whose remount must not wipe the saved offset.
      return (
        <StrictMode>
          <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
            {filePreview(relativePath)}
          </div>
        </StrictMode>
      );
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using screen = await render(sourceFile("a.ts", 2000));
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(5000));
    scroller()!.scrollTop = 4200;
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));

    await screen.rerender(sourceFile("b.ts", 1500));
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(0));
    await screen.rerender(sourceFile("a.ts", 2000));

    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));
  });

  it.each([
    {
      label: "keeps a downward drag whose anchor stays mounted across a window shift",
      startLine: 110,
      endLine: 165,
      anchorStaysMounted: true,
    },
    {
      label: "keeps a downward drag whose anchor unmounts on a window shift",
      startLine: 5,
      endLine: 165,
      anchorStaysMounted: false,
    },
    {
      label: "keeps an upward drag whose anchor unmounts on a window shift",
      startLine: 385,
      endLine: 250,
      anchorStaysMounted: false,
    },
  ])("$label", async ({ startLine, endLine, anchorStaysMounted }) => {
    using _settings = setup();
    localStorage.setItem("t3code.renderMarkdown", "false");
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["markdown"] });

    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} markdown content`);
    const contents = `${lines.join("\n")}\n`;
    state.file = {
      relativePath: "notes.md",
      contents,
      byteLength: contents.length,
      truncated: false,
    };

    await using screen = await render(
      <div style={{ width: 560, height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("notes.md")}
      </div>,
    );

    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
    const row = (line: number) => root.querySelector<HTMLElement>('[data-line="' + line + '"]');
    const rowBox = (line: number) => {
      const box = row(line)?.getBoundingClientRect();
      expect(box).toBeDefined();
      const viewport = scroller.getBoundingClientRect();
      expect(box!.height).toBeGreaterThan(0);
      expect(box!.top).toBeGreaterThanOrEqual(viewport.top);
      expect(box!.bottom).toBeLessThanOrEqual(viewport.bottom);
      return box!;
    };
    const wait = { timeout: 5000 };
    const content = await vi.waitFor(() => {
      const editable = root.querySelector<HTMLElement>('[data-content][contenteditable="true"]');
      expect(editable).not.toBeNull();
      return editable!;
    }, wait);
    const lineHeight = await vi.waitFor(() => rowBox(5).height, wait);
    const scrollTo = (line: number) => {
      scroller.scrollTop = (line - 1) * lineHeight - scroller.clientHeight / 2;
    };
    scrollTo(startLine);
    await vi.waitFor(() => rowBox(startLine), wait);
    const mountedRows = () => root.querySelectorAll<HTMLElement>("[data-line]");
    const firstMounted = mountedRows()[0];
    const goingUp = endLine < startLine;
    const rowText = (element: HTMLElement) => element.querySelector("span")!.firstChild!;

    const copied = () => {
      const clipboardData = new DataTransfer();
      const handled = !content.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return handled ? clipboardData.getData("text/plain") : null;
    };
    const selection = document.getSelection()!;
    const start = row(startLine)!;
    const startNode = rowText(start);
    const startOffset = goingUp ? startNode.textContent!.length : 0;
    content.focus({ preventScroll: true });
    await vi.waitFor(() => expect(root.activeElement).toBe(content), wait);
    start.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        composed: true,
        pointerType: "mouse",
        buttons: 1,
      }),
    );
    try {
      selection.collapse(startNode, startOffset);
      document.dispatchEvent(new Event("selectionchange"));
      const neighbor = row(startLine + (goingUp ? -1 : 1))!;
      selection.extend(rowText(neighbor), goingUp ? 0 : neighbor.textContent!.length);
      document.dispatchEvent(new Event("selectionchange"));
      await vi.waitFor(
        () => expect(root.querySelector("[data-selection-range]")).not.toBeNull(),
        wait,
      );

      scrollTo(endLine);
      await vi.waitFor(() => {
        expect(mountedRows()[0]).not.toBe(firstMounted);
        expect(row(startLine) !== null).toBe(anchorStaysMounted);
        rowBox(endLine);
      }, wait);
      const rows = mountedRows();
      const anchor = row(startLine) ?? (goingUp ? rows[rows.length - 1]! : rows[0]!);
      const end = row(endLine)!;
      selection.setBaseAndExtent(
        rowText(anchor),
        goingUp ? anchor.textContent!.length : 0,
        rowText(end),
        goingUp ? 0 : end.textContent!.length,
      );
      await vi.waitFor(() => {
        const text = copied();
        expect(text).toContain(lines[startLine - 1]);
        expect(text).toContain(lines[endLine - 1]);
      }, wait);
    } finally {
      document.body.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }),
      );
    }

    expect(root.querySelector("[data-selection-range]")).not.toBeNull();
    expect(copied()).toContain(lines[startLine - 1]);
    expect(copied()).toContain(lines[endLine - 1]);
  });

  it("scrolls a find match below many wrapped lines into view", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const wrapped = "wrap ".repeat(60);
    const lines = Array.from({ length: 800 }, (_, i) => `const line${i} = "${wrapped}";`);
    lines.push(
      "const needle = 1;",
      ...Array.from({ length: 40 }, (_, i) => `const tail${i} = ${i};`),
    );
    const contents = lines.join("\n");
    state.file = {
      relativePath: "wrapped.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    await using screen = await render(
      <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("wrapped.ts")}
      </div>,
    );
    const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
    const root = screen.container.querySelector("diffs-container")!.shadowRoot!;
    const row = (line: number) => root.querySelector<HTMLElement>('[data-line="' + line + '"]');
    const wait = { timeout: 5000 };
    const firstRow = await vi.waitFor(() => {
      const first = row(1);
      expect(first).not.toBeNull();
      expect(first!.getBoundingClientRect().height).toBeGreaterThan(
        Number.parseFloat(getComputedStyle(first!).lineHeight),
      );
      expect(root.querySelector('[data-content][contenteditable="true"]')?.contains(first!)).toBe(
        true,
      );
      return first!;
    }, wait);
    await userEvent.click(firstRow);
    await vi.waitFor(() => expect(root.activeElement?.matches("[data-content]")).toBe(true), wait);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    const search = await vi.waitFor(() => {
      const input = root.querySelector<HTMLInputElement>("input[data-search]");
      expect(input).not.toBeNull();
      expect(root.activeElement).toBe(input);
      return input!;
    }, wait);
    await userEvent.keyboard("needle");
    expect(search.value).toBe("needle");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => {
      const viewport = scroller.getBoundingClientRect();
      const match = row(801);
      expect(match?.textContent).toBe("const needle = 1;");
      const box = match!.getBoundingClientRect();
      expect(box.height).toBeGreaterThan(0);
      expect(box.top).toBeGreaterThanOrEqual(viewport.top);
      expect(box.bottom).toBeLessThanOrEqual(viewport.bottom);
    }, wait);
  });
});

describe("rendered Markdown select all", () => {
  it("copies the whole chunked file with its own line endings", async () => {
    using _settings = setup();
    const contents = `first\r\r# ${"x\r\r# ".repeat(2_000)}end`;
    await using _screen = await render(
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        {markdownPreview(false, contents, "cr.md")}
      </div>,
    );
    const firstChunk = await vi.waitFor(() => {
      const first = document.querySelector("h1");
      expect(first).not.toBeNull();
      return first!;
    });
    await userEvent.click(firstChunk);
    const list = firstChunk.closest(".legend-list-content-container")!.parentElement!;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const wholeList = document.createRange();
    wholeList.selectNode(list);
    selection.addRange(wholeList);
    const clipboardData = new DataTransfer();
    const handled = !firstChunk.dispatchEvent(
      new ClipboardEvent("copy", {
        clipboardData,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    expect(handled).toBe(true);
    expect(clipboardData.getData("text/plain")).toBe(contents);
  });
});

describe("rendered Markdown relative images", () => {
  it.each([
    ["2026-11-23T14:05/README.md", "/workspace/2026-11-23T14:05/diagram.png"],
    ["/README.md", "/diagram.png"],
  ])("resolves relative images in %s against its folder", async (relativePath, expectedPath) => {
    using _settings = setup();
    await using _screen = await render(
      markdownPreview(false, "![diagram](diagram.png)\n", relativePath),
    );
    await vi.waitFor(() => expect(state.assetResources).not.toHaveLength(0));
    expect(state.assetResources).toContainEqual(
      expect.objectContaining({ _tag: "media-file", path: expectedPath }),
    );
  });
});

describe("rendered Markdown task saves", () => {
  it("renders the whole file of a truncated read, read-only", async () => {
    using _settings = setup();
    state.assetUrl = {
      _tag: "Success",
      url: "/assets/tasks.md",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const realFetch = globalThis.fetch;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        new URL(input instanceof Request ? input.url : String(input), location.href).pathname ===
        "/assets/tasks.md"
          ? Promise.resolve(
              new Response("- [ ] Keep the rest of this file\n\nPast the first megabyte\n"),
            )
          : realFetch(input, init),
      );
    await using screen = await render(markdownPreview(true));
    await expect.element(screen.getByText("Past the first megabyte")).toBeVisible();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    // The virtualized list mounts its pieces after measuring the viewport.
    await expect.element(screen.getByRole("checkbox")).toBeInTheDocument();
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });
});

function withAppCss() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

function sized(children: ReactNode) {
  return (
    <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

describe("rendered Markdown scroll position", () => {
  const sections = Array.from(
    { length: 200 },
    (_, index) => `## Section ${index}\n\nParagraph ${index}.\n`,
  ).join("\n");
  const scroller = () =>
    document.querySelector<HTMLElement>(".scrollbar-gutter-both") ?? expect.unreachable();
  /** The first heading in view and its offset from the top of the viewport. */
  const readingPosition = () => {
    const top = scroller().getBoundingClientRect().top;
    for (const heading of scroller().querySelectorAll("h2")) {
      const offset = Math.round(heading.getBoundingClientRect().top - top);
      if (offset > -100) return { heading: heading.textContent, offset };
    }
    return null;
  };
  const scrollDown = async () => {
    scroller().scrollTop = 3000;
    scroller().dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(readingPosition()?.heading).not.toBe("Section 0"));
    return readingPosition();
  };
  const expectReadingPosition = (saved: ReturnType<typeof readingPosition>) =>
    vi.waitFor(() => {
      const position = readingPosition();
      expect(position?.heading).toBe(saved?.heading);
      expect(Math.abs((position?.offset ?? 0) - (saved?.offset ?? 0))).toBeLessThanOrEqual(2);
    });

  it("restores each file's reading position after the preview remounts", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const preview = (relativePath: string) => sized(markdownPreview(false, sections, relativePath));

    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(preview("long.md"));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      saved = await scrollDown();
    }
    {
      await using screen = await render(preview("other.md"));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      expect(scroller().scrollTop, "another file opens at the top").toBe(0);
    }
    await using _screen = await render(preview("long.md"));
    await expectReadingPosition(saved);
  });

  it("waits for the saved chunk when a reopened file is still streaming in", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const { chunks, definitions } = splitMarkdown(sections, 200);
    const preview = (loaded: number, loading: boolean) =>
      sized(
        <ChunkedMarkdown
          chunks={chunks.slice(0, loaded)}
          definitions={definitions}
          loading={loading}
          cwd="/workspace"
          relativePath="streaming.md"
          threadRef={threadRef}
          workspaceMutationId={null}
        />,
      );

    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(preview(chunks.length, false));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      saved = await scrollDown();
    }
    await using screen = await render(preview(3, true));
    expect(document.querySelector(".scrollbar-gutter-both"), "no list before the chunk").toBeNull();
    await screen.rerender(preview(chunks.length, false));
    await expectReadingPosition(saved);
  });

  it("keeps each thread's position when the same file stays open across threads", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const { chunks, definitions } = splitMarkdown(sections, 200);
    const preview = (threadId: string) =>
      sized(
        <ChunkedMarkdown
          chunks={chunks}
          definitions={definitions}
          cwd="/workspace"
          relativePath="shared.md"
          threadRef={{ environmentId, threadId: ThreadId.make(threadId) }}
          workspaceMutationId={null}
        />,
      );

    await using screen = await render(preview("first"));
    await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
    const saved = await scrollDown();
    await screen.rerender(preview("second"));
    await vi.waitFor(() => expect(readingPosition()?.heading).toBe("Section 0"));
    await screen.rerender(preview("first"));
    await expectReadingPosition(saved);
  });
});

describe("rendered Markdown footnotes across chunks", () => {
  it("renders cross-chunk footnotes with document-wide numbering and one footnotes section", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) =>
        `Paragraph ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2)}`,
    );
    const markdown = [
      "A footnote reference.[^1]",
      "",
      ...paragraphs.slice(0, 35).flatMap((p) => [p, ""]),
      "Second note[^second] and repeat[^1].",
      "",
      ...paragraphs.slice(35).flatMap((p) => [p, ""]),
      "[^1]: The footnote text.",
      "[^second]: The second footnote.",
      "",
      "    - [ ] Footnote task",
    ].join("\n");
    const onTaskListChange = vi.fn();

    const split = splitMarkdown(markdown);
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.footnotes).toBeDefined();

    await using screen = await render(
      sized(
        <ChunkedMarkdown
          {...split}
          cwd="/workspace"
          relativePath="footnotes.md"
          threadRef={threadRef}
          workspaceMutationId={null}
          onTaskListChange={onTaskListChange}
        />,
      ),
    );

    const firstRef = await vi.waitFor(() => {
      const link = screen.container.querySelector<HTMLAnchorElement>(
        'a[data-footnote-ref][href="#user-content-fn-1"]',
      );
      expect(link).not.toBeNull();
      return link!;
    });
    expect(firstRef.textContent).toBe("1");
    expect(screen.container.textContent).not.toContain("[^1]");

    // Clicking the footnote ref scrolls to the trailing footnotes section even in a virtualized list.
    firstRef.click();
    await vi.waitFor(() => {
      const sections = screen.container.querySelectorAll("section[data-footnotes]");
      expect(sections.length).toBe(1);
      expect(sections[0]!.textContent).toContain("The footnote text.");
      expect(sections[0]!.textContent).toContain("The second footnote.");
    });

    // A task in a footnote edits its line in the file, not in the section's own text.
    await act(async () =>
      screen.container
        .querySelector<HTMLInputElement>('section[data-footnotes] input[type="checkbox"]')!
        .click(),
    );
    expect(onTaskListChange).toHaveBeenCalledExactlyOnceWith({
      markerOffset: markdown.indexOf("[ ] Footnote task"),
      checked: true,
    });

    // Clicking the backref returns to the first reference (fnref-1) at the top of chunk 0.
    const backref = screen.container.querySelector<HTMLAnchorElement>(
      'section[data-footnotes] a[data-footnote-backref][href="#user-content-fnref-1"]',
    );
    expect(backref).not.toBeNull();
    const scroller = screen.container.querySelector<HTMLElement>(".scrollbar-gutter-both")!;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    backref!.click();
    await vi.waitFor(() => {
      const topRef = screen.container.querySelector<HTMLAnchorElement>(
        'a[data-footnote-ref][id$="fnref-1"]',
      );
      expect(topRef).not.toBeNull();
      expect(topRef!.textContent).toBe("1");
      expect(scroller.scrollTop).toBeLessThan(200);
    });
  });
});
