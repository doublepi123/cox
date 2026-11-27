import "~/index.css";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { commands, page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { RightPanelTabs, type RightPanelTabsProps } from "./RightPanelTabs";
import type { RightPanelSurface } from "~/rightPanelStore";

const noop = () => {};
const tabs = (available: boolean, props: Partial<RightPanelTabsProps> = {}) => (
  <RightPanelTabs
    mode="embedded"
    open
    keybindings={DEFAULT_RESOLVED_KEYBINDINGS}
    getShortcutContext={() => ({
      terminalFocus: false,
      terminalOpen: false,
      previewFocus: false,
      previewOpen: false,
      isWeb: true,
      isDesktop: false,
    })}
    surfaces={[]}
    environmentId={null}
    activeSurfaceId={null}
    pendingSurfaceIds={new Set()}
    previewSessions={{}}
    terminalLabelsById={new Map()}
    onActivate={noop}
    onCloseSurface={noop}
    onCloseSelectedSurfaces={noop}
    onCloseOtherSurfaces={noop}
    onCloseSurfacesToRight={noop}
    onCloseAllSurfaces={noop}
    onCopyFilePath={noop}
    onAddBrowser={noop}
    onAddBrowserInProfile={noop}
    onAddTerminal={noop}
    onAddDiff={noop}
    onAddFiles={noop}
    onAddPullRequest={noop}
    onAddPullRequests={noop}
    onAddSideChat={noop}
    browserAvailable={false}
    terminalAvailable={false}
    diffAvailable={false}
    filesAvailable={false}
    pullRequestAvailable={false}
    pullRequestsAvailable={false}
    sideChatAvailable={available}
    {...props}
  >
    {null}
  </RightPanelTabs>
);

it("closes the add menu and releases Mod+T when no surface can be added", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const press = async () => {
    const event = new KeyboardEvent("keydown", {
      key: "t",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(() => document.body.dispatchEvent(event));
    return event.defaultPrevented;
  };
  await using screen = await render(tabs(true));
  const addButton = screen.getByRole("button", { name: "Add panel surface" });
  await expect.element(addButton).toBeVisible();
  expect(await press()).toBe(true);
  await expect.element(page.getByRole("menu")).toBeVisible();
  await screen.rerender(tabs(false));
  await expect.element(addButton).not.toBeInTheDocument();
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  expect(await press()).toBe(false);
});

it("drags a Shift-clicked range and closes it from a selected tab's menu", async () => {
  const DIFF_SURFACE: RightPanelSurface = { id: "diff", kind: "diff" };
  const files: RightPanelSurface = { id: "files", kind: "files" };
  const linkedItems: RightPanelSurface = { id: "pull-requests", kind: "pull-requests" };
  const onMoveSurfaces = vi.fn();
  const onCloseSelectedSurfaces = vi.fn();
  await using screen = await render(
    tabs(false, {
      surfaces: [DIFF_SURFACE, files, linkedItems],
      activeSurfaceId: "diff",
      onMoveSurfaces,
      onCloseSelectedSurfaces,
    }),
  );
  const diffTab = screen.getByRole("button", { name: "Diff", exact: true });
  const filesTab = screen.getByRole("button", { name: "Files", exact: true });
  const linkedItemsTab = screen.getByRole("button", { name: "Pull requests", exact: true });

  await userEvent.click(linkedItemsTab, { modifiers: ["Shift"] });
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "true");
  await userEvent.keyboard("{Escape}");
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "false");

  await userEvent.click(filesTab, { modifiers: ["Shift"] });
  await expect.element(diffTab).toHaveAttribute("aria-pressed", "true");
  await expect.element(filesTab).toHaveAttribute("aria-pressed", "true");
  await expect.element(linkedItemsTab).toHaveAttribute("aria-pressed", "false");

  await userEvent.hover(filesTab);
  await commands.pointerDown();
  try {
    await userEvent.hover(filesTab, { position: { x: 1, y: 5 } });
    await userEvent.hover(linkedItemsTab, { force: true });
    await vi.waitFor(() => {
      const dragged = getComputedStyle(filesTab.element().closest("[data-selected-tab]")!);
      const peer = getComputedStyle(diffTab.element().closest("[data-selected-tab]")!);
      expect(dragged.transform).not.toBe("none");
      expect(peer.transform).toBe(dragged.transform);
    });
  } finally {
    await commands.pointerUp();
  }
  expect(onMoveSurfaces).toHaveBeenCalledExactlyOnceWith(["diff", "files"], "pull-requests");

  await userEvent.click(diffTab, { button: "right" });
  await userEvent.click(page.getByRole("menuitem", { name: "Close selected tabs" }));
  expect(onCloseSelectedSurfaces).toHaveBeenCalledExactlyOnceWith([DIFF_SURFACE, files]);
});
