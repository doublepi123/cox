import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
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
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
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

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.optimistic = null;
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

function markdownPreview(truncated: boolean) {
  state.file = {
    relativePath: "tasks.md",
    contents: "- [ ] Keep the rest of this file\n",
    byteLength: truncated ? 1_200_000 : 32,
    truncated,
  };
  return filePreview("tasks.md");
}

function filePreview(relativePath: string) {
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
      revealLine={null}
      revealRequestId={0}
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
      startLine: 65,
      initialScrollLine: 65,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps a downward drag whose anchor unmounts on a window shift",
      startLine: 5,
      initialScrollLine: null,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps an upward drag whose anchor unmounts on a window shift",
      startLine: 385,
      initialScrollLine: 385,
      direction: "up" as const,
      targetFirstMounted: 201,
      expectedIncludedLine: 290,
    },
  ])(
    "$label",
    async ({
      startLine,
      initialScrollLine,
      direction,
      targetFirstMounted,
      expectedIncludedLine,
    }) => {
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

      const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
      const rows = () => shadowRoot()?.querySelectorAll<HTMLElement>("[data-line]") ?? [];
      await vi.waitFor(() =>
        expect(
          shadowRoot()?.querySelector('[data-content][contenteditable="true"]'),
        ).not.toBeNull(),
      );

      const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
      if (initialScrollLine !== null) {
        await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(5000));
        if (direction === "up") {
          scroller.scrollTop = scroller.scrollHeight;
          await vi.waitFor(() =>
            expect(
              [...rows()].some((row) => row.getAttribute("data-line") === String(startLine)),
            ).toBe(true),
          );
        } else {
          scroller.scrollTop = ((initialScrollLine - 1) / lines.length) * scroller.scrollHeight;
        }
        const target = await vi.waitFor(() => {
          const row = [...rows()].find(
            (candidate) => candidate.getAttribute("data-line") === String(initialScrollLine),
          );
          expect(row).toBeDefined();
          return row!;
        });
        target.scrollIntoView({ block: direction === "up" ? "end" : "start" });
        await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
      }

      const startRow = [...rows()].find(
        (row) => row.getAttribute("data-line") === String(startLine),
      );
      expect(startRow).toBeDefined();
      const startRect = startRow!.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const nearEdgeY = direction === "down" ? scrollerRect.bottom - 5 : scrollerRect.top + 5;
      const outsideEdgeY = direction === "down" ? scrollerRect.bottom + 60 : scrollerRect.top - 60;
      const frame = window.frameElement?.getBoundingClientRect();
      const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
        cdp().send("Input.dispatchMouseEvent", {
          type,
          x: x + (frame?.left ?? 0),
          y: y + (frame?.top ?? 0),
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });

      const startX = direction === "up" ? startRect.left + 140 : startRect.left + 2;
      // The editor records the drag anchor on the press's selectionchange; drag only after it.
      const anchored = new Promise((resolve) =>
        document.addEventListener("selectionchange", resolve, { once: true }),
      );
      await mouse("mousePressed", startX, startRect.top + 5);
      await anchored;
      await mouse("mouseMoved", startRect.left + 80, nearEdgeY);
      await mouse("mouseMoved", startRect.left + 80, outsideEdgeY);
      await vi.waitFor(() => {
        const firstMounted = Number(rows()[0]?.getAttribute("data-line"));
        if (direction === "down") {
          expect(firstMounted).toBeGreaterThanOrEqual(targetFirstMounted);
        } else {
          expect(firstMounted).toBeLessThanOrEqual(targetFirstMounted);
        }
      });
      await mouse("mouseReleased", startRect.left + 80, outsideEdgeY);

      const overlayRanges = shadowRoot()!.querySelectorAll("[data-selection-range]");
      expect(overlayRanges.length).toBeGreaterThan(0);

      const clipboardData = new DataTransfer();
      const contentEl = shadowRoot()!.querySelector("[data-content]")!;
      const handled = !contentEl.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      expect(handled).toBe(true);
      const copied = clipboardData.getData("text/plain");
      expect(copied).toContain(`line ${startLine} `);
      expect(copied).toContain(`line ${expectedIncludedLine} markdown content`);
    },
  );

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
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using _screen = await render(
      <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("wrapped.ts")}
      </div>,
    );
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(20_000));
    const shadowRows = () =>
      [...document.querySelectorAll("*")].flatMap((host) =>
        host.shadowRoot ? [...host.shadowRoot.querySelectorAll<HTMLElement>("[data-line]")] : [],
      );
    await userEvent.click(shadowRows().find((row) => row.getAttribute("data-line") === "1")!);
    await vi.waitFor(() => expect(deepActiveElement()?.matches("[data-content]")).toBe(true));
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));
    await userEvent.keyboard("needle{Enter}");

    const visibleLines = () => {
      const viewport = scroller()!.getBoundingClientRect();
      return shadowRows()
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.height > 0 && box.top >= viewport.top && box.bottom <= viewport.bottom;
        })
        .map((row) => Number(row.getAttribute("data-line")));
    };
    await vi.waitFor(() => expect(visibleLines()).toContain(801));
  });
});

describe("rendered Markdown task saves", () => {
  it("keeps a truncated read read-only without queuing a replacement", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(true));
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.readOnly).toBe(true);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(checkbox.checked).toBe(false);
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
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
