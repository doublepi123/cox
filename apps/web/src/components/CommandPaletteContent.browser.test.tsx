import { useState } from "react";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "../index.css";

import { render, stubGlobal } from "../../test/render";
import { CommandPaletteContent } from "./CommandPaletteContent";
import { CommandDialog, CommandDialogPopup, CommandItem, CommandList } from "./ui/command";

function SubmenuPalette() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <CommandDialog open={open} onOpenChange={setOpen}>
        <CommandDialogPopup aria-label="Command palette">
          <CommandPaletteContent
            items={["Project A"]}
            inputProps={{
              placeholder: "Search projects",
              startAddon: (
                <button type="button" aria-label="Back">
                  Back
                </button>
              ),
            }}
          >
            <CommandList>
              {(item: string) => <CommandItem value={item}>{item}</CommandItem>}
            </CommandList>
          </CommandPaletteContent>
        </CommandDialogPopup>
      </CommandDialog>
    </>
  );
}

describe("CommandPaletteContent", () => {
  it("focuses the search input, not the Back button, when it opens into a submenu", async () => {
    await using _screen = await render(<SubmenuPalette />);

    await userEvent.click(page.getByRole("button", { name: "Open" }));

    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });

  it("keeps touch search closed until the user taps the input", async () => {
    const matchMedia = window.matchMedia.bind(window);
    using _pointer = stubGlobal("matchMedia", (query: string) => {
      const media = matchMedia(query);
      if (query === "(pointer: coarse)") {
        Object.defineProperty(media, "matches", { value: true });
      }
      return media;
    });
    await using _screen = await render(<SubmenuPalette />);
    await userEvent.click(page.getByRole("button", { name: "Open" }));
    await expect.element(page.getByRole("dialog", { name: "Command palette" })).toHaveFocus();
    await expect.element(page.getByPlaceholder("Search projects")).not.toHaveFocus();
    await userEvent.click(page.getByPlaceholder("Search projects"));
    await expect.element(page.getByPlaceholder("Search projects")).toHaveFocus();
  });
});
