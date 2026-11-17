import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { SidebarMenu, SidebarProvider } from "../ui/sidebar";
import { MobileBranchOverflowTrigger } from "../BranchToolbar";
import { MobileServerSwitcher } from "./MobileServerSwitcher";

async function viewportScope(width: number, height: number) {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  await page.viewport(width, height);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(originalWidth, originalHeight);
    },
  };
}

describe("MobileServerSwitcher", () => {
  it("opens the native server switcher from a thumb-sized sidebar control", async () => {
    const postMessage = vi.fn();
    using _self = stubGlobal("self", window.top);
    using _bridge = stubGlobal("__coxMobileShell__", {
      info: { platform: "ios", activeServerLabel: "Workstation", serverCount: 2 },
      bridgeToken: "mobile-bridge-token",
      postMessage,
    });
    await using _viewport = await viewportScope(390, 844);
    await using screen = await render(
      <SidebarProvider>
        <div className="w-[390px]">
          <SidebarMenu layout="utilities">
            <MobileServerSwitcher />
          </SidebarMenu>
        </div>
      </SidebarProvider>,
      { router: false },
    );

    const button = screen.getByRole("button", { name: "Servers: Workstation", exact: true });
    await expect.element(button).toBeVisible();
    const box = button.element().getBoundingClientRect();
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(document.querySelector("[data-mobile-workspace-bar]")).toBeNull();

    await button.click();
    expect(postMessage).toHaveBeenCalledWith({
      type: "hapticSelection",
      bridgeToken: "mobile-bridge-token",
    });
    expect(postMessage).toHaveBeenCalledWith({
      type: "openServerSwitcher",
      bridgeToken: "mobile-bridge-token",
    });
  });

  it("stays out of the sidebar without a mobile shell", async () => {
    await using _viewport = await viewportScope(390, 844);
    await using screen = await render(
      <SidebarProvider>
        <SidebarMenu>
          <MobileServerSwitcher />
        </SidebarMenu>
      </SidebarProvider>,
      { router: false },
    );
    expect(screen.container.querySelector("[data-mobile-server-switcher]")).toBeNull();
  });
});

describe("compact phone header", () => {
  it.each([640, 641, 1280] as const)(
    "shows the branch overflow trigger only within the compact boundary at %ipx",
    async (width) => {
      await using _viewport = await viewportScope(width, width === 1280 ? 800 : 844);
      await using screen = await render(<MobileBranchOverflowTrigger />, { router: false });

      const overflow = screen.getByRole("button", { name: "Branch / Worktree", exact: true });
      if (width === 640) {
        await expect.element(overflow).toBeVisible();
        await expect.element(overflow).toHaveAttribute("data-mobile-branch-overflow", "");
        const box = overflow.element().getBoundingClientRect();
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
      } else {
        await expect.element(overflow).not.toBeInTheDocument();
      }
    },
  );
});
