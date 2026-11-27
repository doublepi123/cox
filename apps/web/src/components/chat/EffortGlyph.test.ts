import { describe, expect, it } from "vite-plus/test";

import { effortBarHeights, resolveEffortGlyph } from "./EffortGlyph";

const descriptor = (ids: ReadonlyArray<string>, promptInjectedValues?: ReadonlyArray<string>) => ({
  id: "effort",
  label: "Reasoning",
  type: "select" as const,
  options: ids.map((id) => ({ id, label: id[0]!.toUpperCase() + id.slice(1) })),
  ...(promptInjectedValues ? { promptInjectedValues } : {}),
});

describe("resolveEffortGlyph", () => {
  const claude = descriptor(
    ["low", "medium", "high", "xhigh", "max", "ultracode", "ultrathink"],
    ["ultrathink"],
  );

  it("fills bars up to the current level and leaves max and workflow levels off the scale", () => {
    expect(resolveEffortGlyph(claude, "xhigh")).toEqual({
      count: 4,
      filled: 4,
      special: null,
      label: "Xhigh",
    });
  });

  it("names Max and Default instead of drawing them", () => {
    expect(resolveEffortGlyph(claude, "max")?.special).toBe("Max");
    const reported = descriptor(["default", "low", "medium", "high", "xhigh", "max"]);
    expect(resolveEffortGlyph(reported, "default")?.special).toBe("Default");
    expect(resolveEffortGlyph(reported, "low")).toMatchObject({ count: 4, filled: 1 });
  });

  it("keeps Ultra named when ordinary effort levels use bars", () => {
    const service = descriptor(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(resolveEffortGlyph(service, "xhigh")).toMatchObject({ count: 4, filled: 4 });
    expect(resolveEffortGlyph(service, "ultra")).toEqual({
      count: 4,
      filled: 4,
      special: "Ultra",
      label: "Ultra",
    });
  });

  it("names Ultracode and Ultrathink instead of drawing a level", () => {
    expect(resolveEffortGlyph(claude, "ultracode")?.special).toBe("Ultracode");
    expect(resolveEffortGlyph(claude, "ultrathink")?.special).toBe("Ultrathink");
  });

  it("draws the lowest level as one bar, and an off level as none", () => {
    expect(resolveEffortGlyph(claude, "low")).toMatchObject({ count: 4, filled: 1 });
    expect(resolveEffortGlyph(claude, "medium")).toMatchObject({ count: 4, filled: 2 });
    expect(resolveEffortGlyph(descriptor(["off", "low", "high"]), "off")).toEqual({
      count: 2,
      filled: 0,
      special: null,
      label: "Off",
    });
  });

  it("rises with effort when an agent lists its levels high to low, ending at off", () => {
    const descending = descriptor(["xhigh", "high", "low", "none"]);
    expect(resolveEffortGlyph(descending, "xhigh")).toMatchObject({ count: 3, filled: 3 });
    expect(resolveEffortGlyph(descending, "high")).toMatchObject({ count: 3, filled: 2 });
    expect(resolveEffortGlyph(descending, "low")).toMatchObject({ count: 3, filled: 1 });
    expect(resolveEffortGlyph(descending, "none")).toMatchObject({ count: 3, filled: 0 });
  });

  it("falls back to the word when the value is unknown or the scale has one level", () => {
    expect(resolveEffortGlyph(claude, "unknown")).toBeNull();
    expect(resolveEffortGlyph(descriptor(["high"]), "high")).toBeNull();
  });
});

describe("effortBarHeights", () => {
  it.each([3, 4, 5, 6, 7])(
    "rises by one whole-pixel step and ends at full height: %i bars",
    (count) => {
      const heights = effortBarHeights(count, 12);
      expect(heights).toHaveLength(count);
      expect(heights.at(-1)).toBe(12);
      const steps = new Set(heights.slice(1).map((height, index) => height - heights[index]!));
      expect(steps.size).toBe(1);
      const [step] = steps;
      expect(Number.isInteger(step) && step! > 0).toBe(true);
    },
  );
});
