import type { DesktopComputerUseState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  desktopComputerControlIndicatorState,
  hasMacOs15InputMonitoringPane,
  missingDesktopComputerPermissions,
} from "./desktopComputerUse";

function computerState(overrides: Partial<DesktopComputerUseState> = {}): DesktopComputerUseState {
  return {
    supported: true,
    enabled: true,
    engine: "ready",
    engineMessage: null,
    permissions: {
      screenRecording: "granted",
      accessibility: "granted",
      input: "granted",
    },
    appName: "Cox",
    appPath: "/Applications/Cox.app",
    macosVersion: "15.3",
    restartRequired: false,
    stopped: false,
    ready: true,
    ...overrides,
  };
}

describe("desktop computer permissions", () => {
  it("treats denied and unknown permissions as missing in guide order", () => {
    expect(
      missingDesktopComputerPermissions(
        computerState({
          permissions: {
            screenRecording: "unknown",
            accessibility: "granted",
            input: "denied",
          },
        }),
      ),
    ).toEqual(["screenRecording", "input"]);
  });

  it.each([
    [null, false],
    ["14.6", false],
    ["15", true],
    ["15.3.1", true],
    ["26.0", true],
    ["unknown", false],
  ] as const)("uses the macOS 15 input pane copy for %s: %s", (version, expected) => {
    expect(hasMacOs15InputMonitoringPane(version)).toBe(expected);
  });
});

describe("computer control header indicator", () => {
  it("stays hidden when unavailable, unsupported, or disabled", () => {
    expect(desktopComputerControlIndicatorState(null, true)).toBeNull();
    expect(
      desktopComputerControlIndicatorState(computerState({ supported: false }), true),
    ).toBeNull();
    expect(
      desktopComputerControlIndicatorState(computerState({ enabled: false }), true),
    ).toBeNull();
  });

  it("distinguishes ready, waiting, unsupported, and stopped states", () => {
    expect(desktopComputerControlIndicatorState(computerState(), true)).toBe("ready");
    expect(desktopComputerControlIndicatorState(computerState({ ready: false }), true)).toBe(
      "waiting",
    );
    expect(desktopComputerControlIndicatorState(computerState(), false)).toBe("unsupported");
    expect(
      desktopComputerControlIndicatorState(computerState({ stopped: true, ready: false }), true),
    ).toBe("stopped");
  });
});
