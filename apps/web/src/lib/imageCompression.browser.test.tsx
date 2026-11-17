import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { prepareImageForAttachment } from "./imageCompression";

it("compresses a real mobile PNG and preserves malformed camera input", async () => {
  await page.viewport(390, 844);
  try {
    const canvas = new OffscreenCanvas(1600, 1200);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    const pixels = context.createImageData(1600, 1200);
    let sample = 0x12345678;
    for (let index = 0; index < pixels.data.length; index += 4) {
      sample ^= sample << 13;
      sample ^= sample >>> 17;
      sample ^= sample << 5;
      pixels.data[index] = sample & 255;
      pixels.data[index + 1] = (sample >>> 8) & 255;
      pixels.data[index + 2] = (sample >>> 16) & 255;
      pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    const photo = new File([await canvas.convertToBlob({ type: "image/png" })], "camera.png", {
      type: "image/png",
    });
    expect(photo.size).toBeGreaterThan(2 * 1024 * 1024);

    const result = await prepareImageForAttachment(photo, 10 * 1024 * 1024);

    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.size).toBeLessThan(photo.size);
    if (!result.ok) throw new Error("Photo compression failed");
    const decoded = await createImageBitmap(result.file);
    expect([decoded.width, decoded.height]).toEqual([1600, 1200]);
    decoded.close();
    const corrupt = new File([new Uint8Array(3 * 1024 * 1024)], "malformed_input.png", {
      type: "image/png",
    });
    expect(await prepareImageForAttachment(corrupt, 10 * 1024 * 1024)).toEqual({
      ok: true,
      file: corrupt,
      recompressed: false,
    });
  } finally {
    await page.viewport(1280, 800);
  }
});
