import "../../index.css";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render, stubGlobal } from "../../../test/render";
import { UsageFrame, UsageWindowClose } from "./UsageFrame";

describe("desktop usage window", () => {
  it("renders a full window without a modal and closes only through its bridge", async () => {
    const closeUsage = vi.fn();
    using _bridge = stubGlobal("coxDesktop", { windowKind: "usage", closeUsage });
    await using screen = await render(
      <UsageFrame>
        <header>Usage</header>
        <UsageWindowClose />
        <div>Usage content</div>
      </UsageFrame>,
      { router: "/usage" },
    );
    expect(screen.container.querySelector("main")).not.toBeNull();
    expect(document.querySelector("[data-app-modal]")).toBeNull();
    await expect.element(page.getByText("Usage content")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    expect(closeUsage).toHaveBeenCalledOnce();
    await userEvent.keyboard("{Escape}");
    expect(closeUsage).toHaveBeenCalledTimes(2);
    expect(screen.router?.state.location.pathname).toBe("/usage");
  });

  it("does not close the window while a nested dialog handles Escape", async () => {
    const closeUsage = vi.fn();
    using _bridge = stubGlobal("coxDesktop", { windowKind: "usage", closeUsage });
    await using _screen = await render(
      <UsageFrame>
        <div role="dialog" aria-label="Usage details">
          Details
        </div>
      </UsageFrame>,
      { router: "/usage" },
    );
    await userEvent.keyboard("{Escape}");
    expect(closeUsage).not.toHaveBeenCalled();
  });

  it("fills its native window, preserves filtering on Escape guards and removes listeners on unmount", async () => {
    const closeUsage = vi.fn();
    using _bridge = stubGlobal("coxDesktop", { windowKind: "usage", closeUsage });
    await using screen = await render(
      <UsageFrame>
        <input aria-label="Filter usage" />
        <div data-popup-open>Filters</div>
      </UsageFrame>,
      { router: "/usage" },
    );
    const bounds = screen.container.querySelector("main")!.getBoundingClientRect();
    expect(bounds.width).toBe(window.innerWidth);
    expect(bounds.height).toBe(window.innerHeight);
    await userEvent.keyboard("{Escape}");
    expect(closeUsage).not.toHaveBeenCalled();
    await screen.rerender(
      <UsageFrame>
        <input aria-label="Filter usage" />
      </UsageFrame>,
    );
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
    expect(closeUsage).not.toHaveBeenCalled();
    await screen.unmount();
    await userEvent.keyboard("{Escape}");
    expect(closeUsage).not.toHaveBeenCalled();
  });

  it("retains the browser modal when no standalone usage role is present", async () => {
    using _bridge = stubGlobal("coxDesktop", undefined);
    await using _screen = await render(
      <UsageFrame>
        <UsageWindowClose />
        <div>Browser usage</div>
      </UsageFrame>,
      { router: "/usage" },
    );
    expect(document.querySelector("[data-app-modal]")).not.toBeNull();
    await expect.element(page.getByRole("dialog", { name: "Usage", exact: true })).toBeVisible();
  });
});
