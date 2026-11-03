import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import "../index.css";

import { render, stubGlobal } from "../../test/render";
import { RightPanelSheet } from "./RightPanelSheet";

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
  await expect.element(page.getByRole("dialog")).toHaveFocus();
  await expect.element(page.getByPlaceholder("Search files")).not.toHaveFocus();
  await page.getByPlaceholder("Search files").click();
  await expect.element(page.getByPlaceholder("Search files")).toHaveFocus();
});
