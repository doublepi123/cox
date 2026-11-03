import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { GhosttyTerminalCore } from "~/terminal/ghostty/core";
import { terminalKeyPressInput } from "~/terminal/ghostty/surface";
import { TERMINAL_TOUCH_KEYS } from "./TerminalTouchKeys";

vi.mock("~/terminal/ghostty/vendor/ghostty-vt.wasm?url", async () => ({
  default: (await import("~/terminal/ghostty/vendor/ghostty-vt.wasm?inline")).default,
}));
vi.mock("~/terminal/ghostty/vendor/ghostty-write-pty.wasm?url&no-inline", async () => ({
  default: (await import("~/terminal/ghostty/vendor/ghostty-write-pty.wasm?inline")).default,
}));

describe("TERMINAL_TOUCH_KEYS", () => {
  const cores = new Set<GhosttyTerminalCore>();

  afterEach(() => {
    for (const core of cores) core.dispose();
    cores.clear();
  });

  async function encodeAll(setup = "") {
    const core = await GhosttyTerminalCore.create(
      12,
      3,
      8,
      16,
      {
        foreground: { r: 255, g: 255, b: 255 },
        background: { r: 0, g: 0, b: 0 },
        cursor: { r: 255, g: 255, b: 255 },
      },
      () => {},
    );
    cores.add(core);
    if (setup) core.write(setup);
    return Object.fromEntries(
      TERMINAL_TOUCH_KEYS.map(({ id, press }) => [
        id,
        core.encodeKey(terminalKeyPressInput(press)),
      ]),
    );
  }

  it("sends the bytes a shell expects for each key", async () => {
    expect(await encodeAll()).toEqual({
      escape: "\x1b",
      tab: "\t",
      interrupt: "\x03",
      up: "\x1b[A",
      down: "\x1b[B",
      left: "\x1b[D",
      right: "\x1b[C",
    });
  });

  it("follows application cursor mode for the arrows", async () => {
    expect(await encodeAll("\x1b[?1h")).toMatchObject({
      up: "\x1bOA",
      down: "\x1bOB",
      left: "\x1bOD",
      right: "\x1bOC",
    });
  });
});
