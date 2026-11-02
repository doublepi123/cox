import { describe, expect, it } from "vite-plus/test";

import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "./composerDispatch.js";

describe("composer dispatch", () => {
  it("queues messages during an active turn by default", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: false })).toBe("queue");
  });

  it("offers immediate steering as the alternate action", () => {
    expect(resolveComposerDispatchMode({ running: true, alternateModifier: true })).toBe("steer");
    expect(alternateComposerDispatchAction()).toBe("steer");
  });

  it("preserves explicitly chosen steering", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: false,
        activeTurnDefault: "steer",
      }),
    ).toBe("steer");
    expect(alternateComposerDispatchAction("steer")).toBe("queue");
  });

  it("queues rather than steering while the active turn cannot accept input", () => {
    expect(
      resolveComposerDispatchMode({
        running: true,
        alternateModifier: true,
        activeTurnDefault: "queue",
        canSteer: false,
      }),
    ).toBe("queue");
  });

  it("starts an idle turn normally", () => {
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: false })).toBe("auto");
    expect(resolveComposerDispatchMode({ running: false, alternateModifier: true })).toBe("auto");
  });
});
