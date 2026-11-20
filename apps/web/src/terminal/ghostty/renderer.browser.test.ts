import { expect, it, vi } from "vite-plus/test";
import { GHOSTTY_CELL_WIDE, type GhosttyCell, type GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const white = { r: 255, g: 255, b: 255 };
const black = { r: 0, g: 0, b: 0 };
const blank: GhosttyCell = {
  text: "",
  wide: GHOSTTY_CELL_WIDE.narrow,
  foreground: black,
  background: white,
  invisible: false,
  bold: false,
  italic: false,
  strikethrough: false,
  overline: false,
  underline: false,
  selected: false,
};

function renderTestRow(cells: GhosttyCell[], context: CanvasRenderingContext2D, cursorX = -1) {
  renderGhosttySnapshot({
    context,
    snapshot: {
      rows: 1,
      cols: cells.length,
      foreground: black,
      background: white,
      cursor: black,
      cursorX,
      cursorY: 0,
      cursorVisible: cursorX >= 0,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells, text: "", isWrapContinuation: false, wrapsToNext: false }],
    },
    metrics: { width: 10, height: 20, baseline: 15 },
    fontSize: 14,
    fontFamily: "monospace",
    padding: 0,
    forceFull: true,
    cursorOn: cursorX >= 0,
  });
}

it.each([
  ["\ue0b4", 10, 19],
  ["\ue0b6", 19, 10],
] as const)("fills the cell with the rounded Powerline cap %s", (text, flat, round) => {
  const canvas = document.createElement("canvas");
  canvas.width = 60;
  canvas.height = 40;
  const context = canvas.getContext("2d")!;
  context.scale(2, 2);
  renderTestRow([blank, { ...blank, text }, blank], context);
  const shade = (x: number, y: number) => context.getImageData(2 * x + 1, 2 * y + 1, 1, 1).data[0];
  expect(shade(flat, 2)).toBeLessThan(128);
  expect(shade(round, 9)).toBeLessThan(128);
  expect(shade(round, 2)).toBeGreaterThan(128);
});

it("centers wide glyphs independently of surrounding text and paints a two-cell cursor", () => {
  const context = document.createElement("canvas").getContext("2d")!;
  const fillText = vi.spyOn(context, "fillText");
  const fillRect = vi.spyOn(context, "fillRect");
  renderTestRow(
    [
      { ...blank, text: "A" },
      { ...blank, text: "\u754c" },
      { ...blank, wide: GHOSTTY_CELL_WIDE.spacerTail },
      { ...blank, text: "B" },
    ],
    context,
    1,
  );
  expect(fillText.mock.calls).toEqual([
    ["A", 0, 15, 10],
    ["\u754c", 20, 15, 20],
    ["B", 30, 15, 10],
    ["\u754c", 20, 15, 20],
  ]);
  expect(fillRect).toHaveBeenCalledWith(10, 0, 20, 20);
});

it("paints a focused block cursor without revealing concealed text or hiding visible decorations", () => {
  const canvas = document.createElement("canvas");
  canvas.width = 12;
  canvas.height = 20;
  const context = canvas.getContext("2d")!;
  const background = { r: 8, g: 8, b: 8 };
  const foreground = { r: 220, g: 220, b: 220 };
  const draw = (invisible: boolean, cursorOn: boolean) => {
    const cell: GhosttyCell = {
      text: "M",
      wide: 0,
      foreground,
      background,
      invisible,
      bold: false,
      italic: false,
      strikethrough: false,
      overline: false,
      underline: true,
      selected: false,
    };
    const snapshot: GhosttySnapshot = {
      rows: 1,
      cols: 1,
      foreground,
      background,
      cursor: foreground,
      cursorX: 0,
      cursorY: 0,
      cursorVisible: cursorOn,
      cursorBlinking: false,
      cursorStyle: 1,
      dirtyRows: new Set([0]),
      rowData: [{ cells: [cell], text: cell.text, isWrapContinuation: false, wrapsToNext: false }],
    };
    renderGhosttySnapshot({
      context,
      snapshot,
      metrics: { width: 12, height: 20, baseline: 15 },
      fontSize: 14,
      fontFamily: "monospace",
      padding: 0,
      forceFull: true,
      cursorOn,
    });
    return context.getImageData(0, 0, 12, 20).data;
  };
  expect(
    draw(true, false)
      .filter((_, index) => index % 4 === 0)
      .every((channel) => channel === 8),
  ).toBe(true);
  expect(
    draw(true, true)
      .filter((_, index) => index % 4 === 0)
      .every((channel) => channel === 220),
  ).toBe(true);
  expect(draw(false, true)[(18 * 12 + 5) * 4]).toBe(8);
});
