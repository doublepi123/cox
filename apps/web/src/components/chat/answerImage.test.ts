import { describe, expect, it } from "vite-plus/test";

import { answerImageFileName, answerImageSize } from "./answerImage";

describe("response image dimensions", () => {
  it("exports short answers at double resolution and bounds tall answers without clipping", () => {
    expect(answerImageSize(720, 800)).toEqual({ width: 720, height: 800, pixelRatio: 2 });
    const tall = answerImageSize(720, 12_000);
    expect(tall.pixelRatio).toBeGreaterThanOrEqual(1);
    expect(tall.height * tall.pixelRatio).toBeLessThanOrEqual(16_000);
    expect(tall.width * tall.height * tall.pixelRatio ** 2).toBeLessThanOrEqual(24_000_000);
  });

  it.each([
    [0, 100],
    [720, -1],
    [NaN, 100],
    [720, Infinity],
    [720, 16_001],
    [10_000, 10_000],
  ])("rejects unusable or excessive dimensions %s x %s", (width, height) => {
    expect(() => answerImageSize(width, height)).toThrow("too long");
  });

  it("rounds fractional dimensions up so the last line is not cropped", () => {
    expect(answerImageSize(719.25, 100.2)).toEqual({ width: 720, height: 101, pixelRatio: 2 });
  });
});

describe("response image file names", () => {
  it("uses a safe response identifier instead of leaking the response text or thread title", () => {
    expect(answerImageFileName("answer-123")).toBe("cox-response-answer-123.png");
    expect(answerImageFileName("../../secret:answer?\n")).toBe("cox-response-secretanswer.png");
    expect(answerImageFileName("中文")).toBe("cox-response.png");
    expect(answerImageFileName("x".repeat(100))).toBe(`cox-response-${"x".repeat(48)}.png`);
  });
});
