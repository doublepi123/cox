import type { SnapShotSource } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const snapShotSource: SnapShotSource = {
  kind: "snap-shot",
  capturedAt: "2026-01-01T00:00:00.000Z",
  appName: "Finder",
  windowTitle: "Downloads",
};

describe("ExpandedImageDialog", () => {
  it("fits a workspace SVG to the viewer without enlarging the next raster image", async () => {
    const src = URL.createObjectURL(
      new Blob(
        [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 240"><rect width="600" height="240"/></svg>',
        ],
        { type: "image/svg+xml" },
      ),
    );
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(src) };
    await using screen = await render(
      <ExpandedImageDialog
        preview={{
          images: [
            {
              src,
              name: "Diagram",
              actionsSource: {
                kind: "image",
                src,
                name: "Diagram",
                reference: { kind: "file", path: "/workspace/diagram#2.svg" },
              },
            },
            { src: PIXEL, name: "Pixel" },
          ],
          index: 0,
        }}
        onClose={() => {}}
      />,
      { router: false },
    );
    const diagram = screen.getByRole("img", { name: "Diagram", exact: true });
    await vi.waitFor(() => {
      const image = diagram.element();
      if (!(image instanceof HTMLImageElement)) throw new Error("Diagram image is missing");
      expect(image.naturalWidth).toBe(300);
      expect(image.getBoundingClientRect().width).toBeGreaterThan(image.naturalWidth);
    });
    await userEvent.keyboard("{ArrowRight}");
    const pixel = screen.getByRole("img", { name: "Pixel", exact: true });
    await vi.waitFor(() => {
      const image = pixel.element();
      if (!(image instanceof HTMLImageElement)) throw new Error("Raster image is missing");
      expect(image.naturalWidth).toBe(1);
      expect(image.getBoundingClientRect().width).toBe(1);
    });
  });

  it("Escape closes a popup opened inside the dialog before the dialog", async () => {
    const onClose = vi.fn();
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: PIXEL, name: "shot.png", source: snapShotSource }], index: 0 }}
        onClose={onClose}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );

    await userEvent.click(screen.getByRole("button", { name: "No accessibility data" }));
    await expect.element(screen.getByText("Accessibility data")).toBeVisible();

    await userEvent.keyboard("{Escape}");
    await expect.element(screen.getByText("Accessibility data")).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();

    // Focus returns to the popup's trigger and opens its tooltip; leave it for a plain control.
    (screen.getByRole("button", { name: "Close image preview" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });
});
