import { ChatAttachmentId } from "@t3tools/contracts";
import { ComposerRestingImagePreviews } from "./ComposerAttachmentStrip";
import { expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";
import { createComposerImageThumbnail } from "../../lib/imageCompression";
import { ComposerImageThumbnail } from "./ComposerImageThumbnail";

it("keeps a native preview available after thumbnail generation has failed", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
  const file = new File([blob], "screenshot.png", { type: "image/png" });
  using _bitmap = vi
    .spyOn(window, "createImageBitmap")
    .mockRejectedValue(new Error("Thumbnail decoder unavailable"));
  vi.stubGlobal("Worker", undefined);
  try {
    expect(await createComposerImageThumbnail(file)).toBeNull();
  } finally {
    vi.unstubAllGlobals();
  }

  const container = document.createElement("div");
  const holdLoad = (event: Event) => event.stopPropagation();
  container.addEventListener("load", holdLoad, true);
  using complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(false);
  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span>Preview unavailable</span>}
    />,
    { container },
  );
  using revoke = vi.spyOn(URL, "revokeObjectURL");
  await expect.element(screen.getByText("Preview unavailable")).toBeVisible();
  const loadingImage = screen.container.querySelector("img")!;
  await loadingImage.decode();
  complete.mockRestore();
  container.removeEventListener("load", holdLoad, true);
  await act(() => loadingImage.dispatchEvent(new Event("load")));
  const image = screen.getByRole("img", { name: file.name });
  await expect.element(image).toBeVisible();
  await expect.element(screen.getByText("Preview unavailable")).not.toBeInTheDocument();
  const src = image.element().getAttribute("src");
  expect(src).toMatch(/^blob:/);
  await screen.unmount();
  expect(revoke).toHaveBeenCalledWith(src);
});

it("shows the fallback while HEIC preparation is pending", async () => {
  let finishReading!: (bytes: ArrayBuffer) => void;
  const metadata = new Promise<ArrayBuffer>((resolve) => {
    finishReading = resolve;
  });
  using _read = vi.spyOn(Blob.prototype, "arrayBuffer").mockReturnValue(metadata);
  const file = new File(["pending"], "photo.heic", { type: "image/heic" });

  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span role="img" aria-label="Preparing image" />}
    />,
  );
  try {
    expect(screen.container.querySelector('[aria-label="Preparing image"]')).not.toBeNull();
  } finally {
    finishReading(new ArrayBuffer(0));
    await createComposerImageThumbnail(file);
  }
});

it("loads the local image before the generated thumbnail is ready", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 2;
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!)));
  const file = new File([blob], "native-first.png", { type: "image/png" });
  let resolveThumbnail!: (bitmap: ImageBitmap) => void;
  const generate = new Promise<ImageBitmap>((resolve) => {
    resolveThumbnail = resolve;
  });
  const bitmap = await createImageBitmap(file);
  using _worker = stubGlobal("Worker", undefined);
  using _bitmap = vi.spyOn(window, "createImageBitmap").mockReturnValue(generate);
  await using screen = await render(
    <ComposerImageThumbnail
      file={file}
      alt={file.name}
      className="size-16 object-cover"
      fallback={<span>Preparing image</span>}
    />,
  );
  try {
    const image = screen.getByRole("img", { name: file.name });
    await expect.element(image).toBeVisible();
    expect(image.element().getAttribute("src")).toMatch(/^blob:/);
  } finally {
    resolveThumbnail(bitmap);
    await createComposerImageThumbnail(file);
  }
});

it.each([1, 2])("announces %s hidden image attachments", async (count) => {
  const images = Array.from({ length: 3 + count }, (_, index) => ({
    type: "image" as const,
    id: ChatAttachmentId.make(`img-${index}`),
    name: `image-${index}.png`,
    mimeType: "image/png",
    sizeBytes: 0,
    previewUrl: "",
    file: new File([], `image-${index}.png`),
  }));
  await using screen = await render(
    <ComposerRestingImagePreviews
      images={images}
      allImages={images}
      resolvedTheme="light"
      onExpandImage={() => {}}
      onShowMore={() => {}}
    />,
  );
  const label = count === 1 ? "Show 1 more image attachment" : "Show 2 more image attachments";
  await expect.element(screen.getByRole("button", { name: label, exact: true })).toBeVisible();
});
