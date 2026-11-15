import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { GhosttyTerminalSurface } from "../../terminal/ghostty/surface";
import { TerminalTouchModifiers } from "../../terminal/ghostty/touchModifiers";
import { readTextFromClipboard } from "../../hooks/useCopyToClipboard";
import { TERMINAL_TOUCH_FONT_SIZE_KEY } from "./touchFontSize";
import { TerminalTouchKeys } from "./TerminalTouchKeys";
import "../../index.css";

it("sends mobile soft input with sticky modifiers, pastes, scrolls history and persists zoom", async () => {
  await page.viewport(390, 844);
  localStorage.removeItem(TERMINAL_TOUCH_FONT_SIZE_KEY);
  const modifiers = new TerminalTouchModifiers();
  const sent: string[] = [];
  let surface: GhosttyTerminalSurface | undefined;
  const paste = () => surface?.pasteFromClipboard(() => readTextFromClipboard("terminal input"));
  await using screen = await render(
    <div style={{ width: "100%", background: "#111827", color: "#e5e7eb" }}>
      <div data-test-terminal style={{ height: 280 }} />
      <TerminalTouchKeys
        modifiers={modifiers}
        onPress={(press) => surface?.pressKey(press)}
        onPaste={() => void paste()}
      />
    </div>,
  );
  const mount = screen.container.querySelector<HTMLElement>("[data-test-terminal]");
  if (!mount) throw new Error("Terminal mount is missing");
  surface = await GhosttyTerminalSurface.create(mount, {
    theme: {
      background: { r: 17, g: 24, b: 39 },
      foreground: { r: 229, g: 231, b: 235 },
      cursor: { r: 255, g: 255, b: 255 },
    },
    font: { size: 13 },
    onData: (data) => sent.push(data),
    onResize() {},
    onSelectionChange() {},
    beforeKey: () => true,
    onLinkActivate() {},
  });
  surface.setTouchModifiers(modifiers);
  try {
    const terminal = surface;
    const softInput = async (text: string) => {
      await act(() => {
        terminal.input.value = text;
        terminal.input.dispatchEvent(
          new InputEvent("input", { data: text, inputType: "insertText" }),
        );
      });
    };
    const ctrl = screen.getByRole("button", { name: "Ctrl", exact: true });
    await ctrl.click();
    await softInput("d");
    await expect.element(ctrl).toHaveAttribute("aria-pressed", "false");
    await ctrl.dblClick();
    await softInput("c");
    await softInput("l");
    await expect.element(ctrl).toHaveAttribute("data-modifier-state", "locked");
    await page.screenshot({ path: "../../../../../.omo/evidence/task-12-terminal-locked.png" });
    await ctrl.click();
    await screen.getByRole("button", { name: "Alt", exact: true }).click();
    await softInput("f");
    expect(sent).toEqual(["\x04", "\x03", "\x0c", "\x1bf"]);

    const clipboard = vi.spyOn(navigator.clipboard, "readText").mockResolvedValue("echo mobile\n");
    try {
      await screen.getByRole("button", { name: "Paste", exact: true }).click();
      await expect.poll(() => sent.at(-1)).toBe("echo mobile\r");
    } finally {
      clipboard.mockRestore();
    }
    await screen.getByRole("button", { name: "Increase terminal font size" }).click();
    expect(localStorage.getItem(TERMINAL_TOUCH_FONT_SIZE_KEY)).toBe("14");
    terminal.write(Array.from({ length: 100 }, (_, index) => `mobile row ${index}\r\n`).join(""));
    expect(terminal.isAtBottom()).toBe(true);
    for (const [type, y] of [
      ["pointerdown", 20],
      ["pointermove", 180],
      ["pointerup", 180],
    ] as const) {
      terminal.canvas.dispatchEvent(
        new PointerEvent(type, {
          pointerType: "touch",
          pointerId: 2,
          isPrimary: true,
          clientX: 40,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    expect(terminal.isAtBottom()).toBe(false);
    await page.screenshot({ path: "../../../../../.omo/evidence/task-12-terminal-mobile.png" });
    await page.viewport(1280, 800);
    await page.screenshot({ path: "../../../../../.omo/evidence/task-12-terminal-desktop.png" });
  } finally {
    surface.dispose();
    localStorage.removeItem(TERMINAL_TOUCH_FONT_SIZE_KEY);
    await page.viewport(1280, 800);
  }
});
