import { redirect, useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { AppRouteModal } from "./AppRouteModal";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

describe("AppRouteModal", () => {
  it("commits a focused field when Esc closes it", async () => {
    const onCommit = vi.fn();
    await using _screen = await render(
      <AppRouteModal label="Settings">
        <CommitOnBlurField onCommit={onCommit} />
      </AppRouteModal>,
      { router: "/settings/general" },
    );

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });
  // regression: #42075. Navigation: Back (mod+[) leaves the Settings route without closing the dialog.
  it("commits a focused field when the route goes back", async () => {
    const onCommit = vi.fn();
    function SettingsRoute() {
      const pathname = useLocation({ select: (location) => location.pathname });
      return pathname.startsWith("/settings") ? (
        <AppRouteModal label="Settings">
          <CommitOnBlurField onCommit={onCommit} />
        </AppRouteModal>
      ) : null;
    }
    await using screen = await render(<SettingsRoute />, { router: "/" });
    // The app redirects /settings, and the router skips onBeforeNavigate after a redirect.
    screen.router!.routeTree.update({
      beforeLoad: ({ location }: { location: { pathname: string } }) => {
        if (location.pathname === "/settings") throw redirect({ to: "/settings/general" });
      },
    });
    await screen.router!.navigate({ to: "/settings" });

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    screen.router!.history.back();

    await expect.element(page.getByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
  });

  it("stays open when a held Esc repeats after closing a nested menu", async () => {
    await using _screen = await render(
      <AppRouteModal label="Usage">
        <Menu>
          <MenuTrigger>All providers</MenuTrigger>
          <MenuPopup>
            <MenuItem>Claude</MenuItem>
          </MenuPopup>
        </Menu>
      </AppRouteModal>,
      { router: "/usage" },
    );
    const usage = page.getByRole("dialog", { name: "Usage" });
    const trigger = page.getByRole("button", { name: "All providers" });
    await expect.element(usage).toHaveFocus();

    (trigger.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    await expect.element(trigger).toHaveFocus();
    await expect.element(usage).toHaveAttribute("data-open");

    await act(() =>
      trigger.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.element(usage).toHaveAttribute("data-open");

    await userEvent.keyboard("{Escape}");
    await expect.element(usage).not.toBeInTheDocument();
  });
});
