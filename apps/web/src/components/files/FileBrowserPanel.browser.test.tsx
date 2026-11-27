import { EnvironmentId, type ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";

import { COMPOSER_MENTION_DRAG_TYPE } from "~/components/chat/composerMentionDrag";
import { dismissContextMenu } from "~/contextMenuFallback";
import { act, render } from "../../../test/render";
import { RightPanelSheet } from "~/components/RightPanelSheet";
import FileBrowserPanel from "./FileBrowserPanel";
import { writeExpandedDirectories } from "./fileTreeExpansion";

const entries: readonly ProjectEntry[] = [
  { path: "src", kind: "directory" },
  { path: "README.md", kind: "file" },
];
const loadingDirectories: ReadonlySet<string> = new Set();
const directory = {
  entries,
  load: () => Promise.resolve(),
  refresh: () => {},
  revalidate: (_path: string) => {},
  ready: true,
  error: null,
  isPending: false,
  loadingDirectories,
};
const pathSearch = {
  entries: [],
  isPending: false,
  error: null,
  truncated: false,
  refresh: () => {},
};

vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => directory }));
vi.mock("~/state/queries", () => ({ useProjectPathSearch: () => pathSearch }));
vi.mock("~/fileContextMenu", () => ({
  useFileContextMenu: () => ({ buildItems: () => [], activate: () => Promise.resolve() }),
}));
const downloadFile = vi.fn();
vi.mock("./useFileDownload", () => ({ useFileDownload: () => downloadFile }));
vi.mock("~/hooks/useWorkspaceMutationRefresh", () => ({ useWorkspaceMutationRefresh: () => {} }));

function findTreeRow(path: string): HTMLElement | null {
  for (const host of document.querySelectorAll("*")) {
    const row = host.shadowRoot?.querySelector<HTMLElement>(`[data-item-path="${path}"]`);
    if (row) return row;
  }
  return null;
}

describe("FileBrowserPanel", () => {
  it("Escape in the file search clears it without closing the panel sheet", async () => {
    const onCloseSheet = vi.fn();
    await using _screen = await render(
      <RightPanelSheet animationDurationMs={0} open onClose={onCloseSheet}>
        <FileBrowserPanel
          environmentId={EnvironmentId.make("env-files")}
          cwd="/repo"
          projectName="repo"
          selectedPath={null}
          selectedPathRevealId={0}
          onOpenFile={() => {}}
          workspaceMutationId={null}
        />
      </RightPanelSheet>,
    );
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "read");
    for (const composition of [
      { key: "Escape", isComposing: true, keyCode: 27 },
      { key: "Escape", isComposing: false, keyCode: 229 },
    ]) {
      // Safari ends the composition just before the Escape keydown.
      await act(() => {
        search.element().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
        search
          .element()
          .dispatchEvent(new KeyboardEvent("keydown", { ...composition, bubbles: true }));
      });
      await expect.element(search).toHaveValue("read");
    }
    expect(search.element().getAttribute("type")).toBe("text");

    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true }),
      );
    });
    expect(onCloseSheet).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onCloseSheet).toHaveBeenCalledOnce());
  });

  it("focuses file search with the platform Find shortcut from the tree", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-find-shortcut"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
      { router: false },
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "f",
        ctrlKey: true,
        metaKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
    await expect.element(page.getByRole("searchbox", { name: "Search repo files" })).toHaveFocus();
  });

  for (const userScrolled of [false, true]) {
    it(`keeps ${userScrolled ? "the user's scroll position" : "the revealed row in view"} after a restored folder listing arrives`, async () => {
      const cwd = userScrolled ? "/repo-reveal-user-scroll" : "/repo-reveal-follow";
      const workspaceKey = `env-files:${cwd}`;
      const rootEntries = Array.from({ length: 12 }, (_, index): ProjectEntry => ({
        path: `d${String(index).padStart(2, "0")}`,
        kind: "directory",
      }));
      const panel = () => (
        <FileBrowserPanel
          environmentId={EnvironmentId.make("env-files")}
          cwd={cwd}
          projectName="repo"
          selectedPath="d09"
          selectedPathRevealId={1}
          onOpenFile={() => {}}
          workspaceMutationId={null}
        />
      );
      using _fixture = {
        [Symbol.dispose]() {
          directory.entries = entries;
          directory.ready = true;
          writeExpandedDirectories(workspaceKey, []);
        },
      };
      writeExpandedDirectories(workspaceKey, ["d01/"]);
      directory.ready = false;
      directory.entries = [];
      const container = document.createElement("div");
      container.style.cssText = "display:flex;flex-direction:column;height:300px;width:300px";
      await using screen = await render(panel(), { container });
      directory.ready = true;
      directory.entries = rootEntries;
      await screen.rerender(panel());
      const scroller = await vi.waitFor(() => {
        const scroller = findTreeRow("d09/")?.getRootNode();
        if (!(scroller instanceof ShadowRoot)) throw new Error("Revealed row is missing");
        const scrollElement = scroller.querySelector("[data-file-tree-virtualized-scroll]");
        if (!(scrollElement instanceof HTMLElement)) throw new Error("Tree scroller is missing");
        return scrollElement;
      });
      const revealedRowIsVisible = () => {
        const row = findTreeRow("d09/")?.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        return row !== undefined && row.top >= viewport.top && row.bottom <= viewport.bottom;
      };
      await vi.waitFor(() => expect(revealedRowIsVisible()).toBe(true));
      if (userScrolled) {
        scroller.dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true }));
        scroller.scrollTop = 0;
      }

      directory.entries = [
        ...rootEntries,
        ...Array.from({ length: 60 }, (_, index): ProjectEntry => ({
          path: `d01/f${index}.ts`,
          kind: "file",
        })),
      ];
      await screen.rerender(panel());
      await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(60 * 24));
      if (userScrolled) expect(scroller.scrollTop).toBe(0);
      else await vi.waitFor(() => expect(revealedRowIsVisible()).toBe(true));
    });
  }

  it("keeps search results current when a large folder listing arrives", async () => {
    const initial: readonly ProjectEntry[] = [
      ...entries,
      { path: "src/target-existing.ts", kind: "file" },
    ];
    directory.entries = initial;
    using _listing = { [Symbol.dispose]: () => (directory.entries = entries) };
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-large-folder-search"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    await using screen = await render(panel());
    const search = page.getByRole("searchbox", { name: "Search repo files" });
    await userEvent.fill(search, "target-");
    await vi.waitFor(() => expect(findTreeRow("src/target-existing.ts")).not.toBeNull());

    directory.entries = [
      ...initial,
      { path: "src/target-new.ts", kind: "file" },
      ...Array.from({ length: 1_000 }, (_, index): ProjectEntry => ({
        path: `src/generated-${index}.ts`,
        kind: "file",
      })),
    ];
    await screen.rerender(panel());

    await vi.waitFor(() => expect(findTreeRow("src/target-new.ts")).not.toBeNull());
    expect(findTreeRow("src/target-existing.ts")).not.toBeNull();
    await expect.element(search).toHaveValue("target-");
  });

  it("restores an expanded folder after remount", async () => {
    const panel = (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-tree-remount"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    await using first = await render(panel);
    await vi.waitFor(() =>
      expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("false"),
    );
    findTreeRow("src/")?.click();
    await vi.waitFor(() => expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("true"));
    await first.unmount();

    using revalidate = vi.spyOn(directory, "revalidate");
    await using _second = await render(panel);
    await vi.waitFor(() => expect(findTreeRow("src/")?.getAttribute("aria-expanded")).toBe("true"));

    // The tree can render its rows again at any time, so compare folders, not calls.
    revalidate.mockClear();
    await userEvent.click(page.getByRole("button", { name: "Refresh workspace files" }));
    expect(new Set(revalidate.mock.calls.flat())).toEqual(new Set(["src", ""]));
  });

  it("opens a chain of single folders from one click and keeps it closed once closed", async () => {
    const chain: readonly ProjectEntry[] = [
      { path: "tests", kind: "directory" },
      { path: "tests/edit", kind: "directory" },
      { path: "tests/edit/unit", kind: "directory" },
      { path: "tests/edit/unit/a.ts", kind: "file" },
    ];
    const panel = () => (
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo-single-folder-chain"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />
    );
    const previous = directory.entries;
    using _listing = {
      [Symbol.dispose]: () => {
        directory.entries = previous;
      },
    };
    directory.entries = chain.slice(0, 1);
    {
      await using screen = await render(panel());
      await vi.waitFor(() => expect(findTreeRow("tests/")).not.toBeNull());
      findTreeRow("tests/")!.click();
      await vi.waitFor(() =>
        expect(findTreeRow("tests/")!.getAttribute("aria-expanded")).toBe("true"),
      );
      for (const listed of [2, 3, 4]) {
        directory.entries = chain.slice(0, listed);
        await screen.rerender(panel());
      }
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).not.toBeNull());

      findTreeRow("tests/edit/unit/")!.click();
      await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/a.ts")).toBeNull());
      directory.entries = [...chain, { path: "tests/edit/unit/b.ts", kind: "file" }];
      await screen.rerender(panel());
      expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");
    }

    directory.entries = [...chain, { path: "pkg", kind: "directory" }];
    await using remounted = await render(panel());
    await vi.waitFor(() => expect(findTreeRow("tests/edit/unit/")).not.toBeNull());
    expect(findTreeRow("tests/edit/unit/")!.getAttribute("aria-expanded")).toBe("false");

    // An ignored folder can hold tens of thousands of entries, so it still opens by hand.
    findTreeRow("pkg/")!.click();
    await vi.waitFor(() => expect(findTreeRow("pkg/")!.getAttribute("aria-expanded")).toBe("true"));
    directory.entries = [
      ...directory.entries,
      { path: "pkg/node_modules", kind: "directory", ignored: true },
    ];
    await remounted.rerender(panel());
    await vi.waitFor(() => expect(findTreeRow("pkg/node_modules/")).not.toBeNull());
    expect(findTreeRow("pkg/node_modules/")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("copies with the pointer and returns to the row after keyboard dismissal", async () => {
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={() => {}}
        workspaceMutationId={null}
      />,
    );
    using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
    using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    async function openRowMenu(path: string) {
      await vi.waitFor(() => expect(findTreeRow(path)).not.toBeNull());
      findTreeRow(path)!.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          composed: true,
          button: 2,
        }),
      );
    }

    await openRowMenu("src/");
    const copyPath = page.getByRole("menuitem", { name: "Copy path", exact: true });
    const download = page.getByRole("menuitem", { name: "Download", exact: true });
    await expect.element(copyPath).toBeVisible();
    expect(download.query()).toBeNull();
    await userEvent.click(copyPath);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("/repo/src"));

    await openRowMenu("README.md");
    const copyMention = page.getByRole("menuitem", { name: "Copy mention", exact: true });
    await expect.element(copyMention).toBeVisible();
    await userEvent.click(copyMention);
    await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("[README.md](README.md)"));

    await openRowMenu("README.md");
    await userEvent.click(download);
    expect(downloadFile).toHaveBeenCalledWith("/repo", "README.md");

    // Hover can take focus when the keyboard menu reopens under the pointer.
    await commands.resetPointer();
    const row = findTreeRow("README.md")!;
    await userEvent.keyboard("{Tab}");
    row.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await expect.element(download).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect((row.getRootNode() as ShadowRoot).activeElement).toBe(row));
  });

  it("dragging a file row carries a composer mention without opening it, and dragend releases it", async () => {
    const onOpenFile = vi.fn();
    await using _screen = await render(
      <FileBrowserPanel
        environmentId={EnvironmentId.make("env-files")}
        cwd="/repo"
        projectName="repo"
        selectedPath={null}
        selectedPathRevealId={0}
        onOpenFile={onOpenFile}
        workspaceMutationId={null}
      />,
    );
    await vi.waitFor(() => expect(findTreeRow("README.md")).not.toBeNull());
    const row = findTreeRow("README.md")!;

    const dataTransfer = new DataTransfer();
    row.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, cancelable: true, composed: true, dataTransfer }),
    );
    // The tree selects the row the drag picked up; mid-drag that must not open it.
    row.click();
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).toBe("true"));

    expect(dataTransfer.getData(COMPOSER_MENTION_DRAG_TYPE)).toContain("README.md");
    expect(onOpenFile).not.toHaveBeenCalled();

    row.dispatchEvent(new DragEvent("dragend", { bubbles: true, composed: true, dataTransfer }));
    await vi.waitFor(() => expect(row.getAttribute("aria-selected")).not.toBe("true"));

    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));

    // The selection stays put, so reopening the selected file must not depend on a selection change.
    row.click();
    await vi.waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(2));
  });
});
