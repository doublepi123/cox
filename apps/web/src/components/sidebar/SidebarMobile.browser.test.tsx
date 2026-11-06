import { createRef } from "react";
import "~/index.css";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from "../ui/sidebar";
import { SidebarChromeFooter, SidebarChromeHeader } from "./SidebarChrome";
import { SidebarHeaderIconButton, SidebarThreadHeader } from "./SidebarThreadHeader";

vi.mock("../../hooks/useSettings", async (original) => ({
  ...(await original<typeof import("../../hooks/useSettings")>()),
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", async (original) => ({
  ...(await original<typeof import("../SidebarStageBackdrop")>()),
  useEnvironmentStageLabel: () => null,
}));
vi.mock("../../state/environments", async (original) => ({
  ...(await original<typeof import("../../state/environments")>()),
  usePullRequestsSupported: () => true,
}));
vi.mock("./SidebarThreadUndoNotice", () => ({ SidebarThreadUndoNotice: () => null }));
vi.mock("./SidebarProviderUpdatePill", () => ({ SidebarProviderUpdatePill: () => null }));

function MobileSidebar() {
  return (
    <SidebarProvider>
      <Sidebar aria-label="Main sidebar">
        <SidebarChromeHeader />
        <SidebarContent
          fixedHeader={
            <div className="p-2">
              <SidebarThreadHeader
                hasProjects
                projectScope={
                  <SidebarHeaderIconButton label="Filter projects">F</SidebarHeaderIconButton>
                }
                onNewProject={() => {}}
                onNewThread={() => {}}
                newThreadDisabled={false}
                newThreadShortcutLabel={null}
                newThreadInProjectShortcutLabel={null}
                showNewThreadInProjectHint={false}
                searchInputRef={createRef<HTMLInputElement>()}
                searchQuery=""
                onSearchQueryChange={() => {}}
                onSearchKeyDown={() => {}}
                isSearching={false}
                searchResultCount={0}
                activeSearchResultIndex={0}
                onClearSearch={() => {}}
              />
            </div>
          }
        >
          <p>看看我当前运行的设备是什么</p>
          {Array.from({ length: 40 }, (_, index) => (
            <p key={index}>Conversation {index + 1}</p>
          ))}
        </SidebarContent>
        <SidebarChromeFooter />
      </Sidebar>
      <SidebarTrigger aria-label="Open navigation" />
    </SidebarProvider>
  );
}

describe("mobile sidebar", () => {
  it.each([320, 390, 430])(
    "fits %ipx screens with distinct touch targets and labeled navigation",
    async (width) => {
      await page.viewport(width, 740);
      await using screen = await render(<MobileSidebar />);
      await screen.getByRole("button", { name: "Open navigation", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Main sidebar", exact: true });
      await expect.element(dialog).toBeVisible();
      const panel = dialog.element();
      await expect
        .poll(
          () =>
            !panel.hasAttribute("data-starting-style") &&
            panel.getAnimations().every((animation) => animation.playState !== "running"),
        )
        .toBe(true);
      const bounds = panel.getBoundingClientRect();
      expect(bounds.width).toBeCloseTo(Math.min(384, width - 16), 0);
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
      const search = dialog
        .getByRole("combobox", { name: "Search threads", exact: true })
        .element();
      expect(Number.parseFloat(getComputedStyle(search).fontSize)).toBeGreaterThanOrEqual(16);
      await expect.element(dialog.getByRole("link", { name: "Cox home" })).toBeVisible();
      const actions = [
        "Toggle main sidebar",
        "Filter projects",
        "Add project",
        "New thread",
        "Settings",
        "Pull requests",
        "Usage",
      ];
      for (const name of actions) {
        const button = dialog.getByRole("button", { name, exact: true }).element();
        const rect = button.getBoundingClientRect();
        expect(rect.width).toBeGreaterThanOrEqual(44);
        expect(rect.height).toBeGreaterThanOrEqual(44);
        expect(rect.left).toBeGreaterThanOrEqual(bounds.left);
        expect(rect.right).toBeLessThanOrEqual(bounds.right);
      }
      const toolbar = ["Filter projects", "Add project", "New thread"].map((name) =>
        dialog.getByRole("button", { name, exact: true }).element().getBoundingClientRect(),
      );
      expect(toolbar[0]!.right).toBeLessThanOrEqual(toolbar[1]!.left);
      expect(toolbar[1]!.right).toBeLessThanOrEqual(toolbar[2]!.left);
      const settings = dialog.getByRole("button", { name: "Settings", exact: true });
      expect(settings.element().textContent).toContain("Settings");
      expect(settings.element().getBoundingClientRect().top).toBeGreaterThan(600);
      expect(settings.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(740);
      await settings.click();
      await expect.element(dialog).not.toBeInTheDocument();
    },
  );
});
