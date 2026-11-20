import { expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../../test/render";
import { Command, CommandItem, CommandList } from "../ui/command";
import { ComposerCommandMenuLayer } from "./ComposerCommandMenuLayer";

it("keeps the first and last suggestions reachable when the composer sits near the window top", async () => {
  const anchor = document.createElement("div");
  anchor.style.cssText = "position:fixed;top:12px;width:260px;--chat-composer-drawer-inset:0";
  document.body.append(anchor);
  try {
    await using _screen = await render(
      <ComposerCommandMenuLayer anchor={anchor}>
        <Command defaultOpen>
          <CommandList spacing="composer">
            {Array.from({ length: 30 }, (_, index) => (
              <CommandItem key={index} value={String(index)}>
                File {index + 1}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </ComposerCommandMenuLayer>,
    );
    const menu = document.querySelector<HTMLElement>("[data-composer-drawer-layer]")!;
    const viewport = menu.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
    expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    const options = viewport.querySelectorAll("[role=option]");
    expect(options[0]?.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    viewport.scrollTop = viewport.scrollHeight;
    expect(options[29]?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      viewport.getBoundingClientRect().bottom,
    );
  } finally {
    anchor.remove();
  }
});
