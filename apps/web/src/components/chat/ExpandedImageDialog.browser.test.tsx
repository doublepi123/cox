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

  it("scrolling pans the image while Ctrl+wheel zooms around the pointer", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    await using screen = await render(
      <ExpandedImageDialog
        preview={{ images: [{ src: canvas.toDataURL(), name: "large.png" }], index: 0 }}
        onClose={() => {}}
      />,
      // The dialog renders no links and reads no route.
      { router: false },
    );
    const viewportLocator = screen.getByRole("region", { name: "large.png, zoomable image" });
    const viewport = viewportLocator.element() as HTMLElement;
    const image = screen.getByRole("img", { name: "large.png" }).element() as HTMLElement;
    await vi.waitFor(() => expect(image.style.width).not.toBe(""));
    const fitWidth = image.getBoundingClientRect().width;
    const wheels: { ctrlKey: boolean; canceled: boolean }[] = [];
    const recordWheel = (event: WheelEvent) =>
      wheels.push({ ctrlKey: event.ctrlKey, canceled: event.defaultPrevented });
    document.addEventListener("wheel", recordWheel);
    using _wheelListener = {
      [Symbol.dispose]: () => document.removeEventListener("wheel", recordWheel),
    };
    // Wheels land on the viewport's center; this is the image fraction under it.
    const pointerFraction = () => {
      const viewportBounds = viewport.getBoundingClientRect();
      const imageBounds = image.getBoundingClientRect();
      return {
        x: (viewportBounds.left + viewportBounds.width / 2 - imageBounds.left) / imageBounds.width,
        y: (viewportBounds.top + viewportBounds.height / 2 - imageBounds.top) / imageBounds.height,
      };
    };
    const ctrlWheel = async (deltaY: number) => {
      await userEvent.keyboard("{Control>}");
      await userEvent.wheel(viewportLocator, { delta: { y: deltaY } });
      await userEvent.keyboard("{/Control}");
    };

    await userEvent.wheel(viewportLocator, { delta: { y: 120 } });
    expect(wheels.at(-1)).toEqual({ ctrlKey: false, canceled: false });
    expect(image.getBoundingClientRect().width).toBe(fitWidth);

    await ctrlWheel(-100);
    expect(wheels.at(-1)).toEqual({ ctrlKey: true, canceled: true });
    const zoomedWidth = image.getBoundingClientRect().width;
    expect(zoomedWidth).toBeCloseTo(fitWidth * Math.E, 0);

    const pan = async (delta: { x: number; y: number }) => {
      const { scrollLeft, scrollTop } = viewport;
      await userEvent.wheel(viewportLocator, { delta });
      await vi.waitFor(() => {
        expect(Math.sign(viewport.scrollLeft - scrollLeft)).toBe(Math.sign(delta.x));
        expect(Math.sign(viewport.scrollTop - scrollTop)).toBe(Math.sign(delta.y));
      });
    };
    await pan({ x: 60, y: 0 });
    await pan({ x: 0, y: 60 });
    await pan({ x: -40, y: -40 });
    expect(wheels.filter((wheel) => !wheel.ctrlKey).every((wheel) => !wheel.canceled)).toBe(true);
    expect(image.getBoundingClientRect().width).toBe(zoomedWidth);

    const anchor = pointerFraction();
    await ctrlWheel(-50);
    expect(image.getBoundingClientRect().width).toBeGreaterThan(zoomedWidth);
    expect(pointerFraction().x).toBeCloseTo(anchor.x, 2);
    expect(pointerFraction().y).toBeCloseTo(anchor.y, 2);
  });
});
