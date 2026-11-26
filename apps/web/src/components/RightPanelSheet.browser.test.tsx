import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../index.css";

import { act, render, stubGlobal } from "../../test/render";
import { RightPanelSheet } from "./RightPanelSheet";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";

it("focuses the touch panel without opening the search keyboard", async () => {
  const matchMedia = window.matchMedia.bind(window);
  using _pointer = stubGlobal("matchMedia", (query: string) => {
    const media = matchMedia(query);
    if (query === "(pointer: coarse)") {
      Object.defineProperty(media, "matches", { value: true });
    }
    return media;
  });
  await using _screen = await render(
    <RightPanelSheet open animationDurationMs={0} onClose={() => {}}>
      <input placeholder="Search files" />
    </RightPanelSheet>,
  );
  await expect.element(page.getByRole("dialog", { name: "Workspace panel" })).toHaveFocus();
  await expect.element(page.getByPlaceholder("Search files")).not.toHaveFocus();
  await page.getByPlaceholder("Search files").click();
  await expect.element(page.getByPlaceholder("Search files")).toHaveFocus();
});

it("stays open when a held Esc repeats after closing a nested menu", async () => {
  const onClose = vi.fn();
  await using _screen = await render(
    <RightPanelSheet open animationDurationMs={0} onClose={onClose}>
      <Menu>
        <MenuTrigger>Add panel surface</MenuTrigger>
        <MenuPopup>
          <MenuItem>Terminal</MenuItem>
        </MenuPopup>
      </Menu>
    </RightPanelSheet>,
  );
  const trigger = page.getByRole("button", { name: "Add panel surface" });
  await expect.element(trigger).toBeVisible();

  (trigger.element() as HTMLElement).focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("menu")).toBeVisible();

  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
  await expect.element(trigger).toHaveFocus();
  expect(onClose).not.toHaveBeenCalled();

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
  expect(onClose).not.toHaveBeenCalled();

  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});
