import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { AppRouteModal } from "../AppRouteModal";
import { SidebarProvider } from "../ui/sidebar";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

it("Esc clears a search of spaces and a held Esc keeps Settings open", async () => {
  await using _screen = await render(
    <AppRouteModal label="Settings">
      <SidebarProvider defaultOpen>
        <SettingsSidebarNav pathname="/settings/general" />
      </SidebarProvider>
    </AppRouteModal>,
    { router: "/settings/general" },
  );
  const settings = page.getByRole("dialog", { name: "Settings" });
  const search = page.getByRole("combobox", { name: "Search settings" });
  await expect.element(settings).toHaveFocus();

  for (const text of ["theme", "   "]) {
    await search.fill(text);
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    await expect.element(search).toHaveFocus();
    await act(() =>
      search.element().dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    await expect.element(settings).toHaveAttribute("data-open");
  }

  await userEvent.keyboard("{Escape}");
  await expect.element(settings).not.toBeInTheDocument();
});
