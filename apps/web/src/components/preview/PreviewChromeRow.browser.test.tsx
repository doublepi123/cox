import { createRef } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { Button } from "../ui/button";
import { PreviewChromeRow } from "./PreviewChromeRow";

function BrowserChrome() {
  return (
    <PreviewChromeRow
      url="http://example.com/"
      loading={false}
      canGoBack
      canGoForward
      refreshDisabled={false}
      urlInputRef={createRef<HTMLInputElement>()}
      onBack={vi.fn()}
      onForward={vi.fn()}
      onRefresh={vi.fn()}
      onSubmit={vi.fn()}
      onOpenInBrowser={vi.fn()}
      onPictureInPicture={vi.fn()}
      trailingActions={
        <Button variant="ghost" size="icon-xs" aria-label="Preview menu">
          <MoreHorizontalIcon />
        </Button>
      }
    />
  );
}

describe("mobile browser chrome", () => {
  it.each([320, 390, 1280])("keeps navigation and the address usable at %ipx", async (width) => {
    await page.viewport(width, 740);
    await using screen = await render(<BrowserChrome />, { router: false });
    const form = screen.container.querySelector<HTMLElement>("[data-surface-subheader]")!;
    expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
    const names = ["Back", "Forward", "Refresh", "Float preview over chat", "Preview menu"];
    for (const name of names) {
      const rect = screen
        .getByRole("button", { name, exact: true })
        .element()
        .getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(width < 640 ? 44 : 24);
      expect(rect.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 24);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
    }
    const address = screen
      .getByRole("textbox", { name: "Search or enter URL", exact: true })
      .element()
      .getBoundingClientRect();
    expect(address.width).toBeGreaterThanOrEqual(48);
  });
});
