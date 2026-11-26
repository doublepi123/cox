import "~/index.css";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { RightPanelTabs } from "./RightPanelTabs";

it("closes the add menu and releases Mod+T when no surface can be added", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  const noop = () => {};
  const tabs = (available: boolean) => (
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
    >
      {null}
    </RightPanelTabs>
  );
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
