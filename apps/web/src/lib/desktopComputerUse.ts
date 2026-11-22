import type { DesktopComputerPermission, DesktopComputerUseState } from "@t3tools/contracts";

export const DESKTOP_COMPUTER_PERMISSION_LABELS: Record<DesktopComputerPermission, string> = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
  input: "Input Monitoring",
};

export const DESKTOP_COMPUTER_PERMISSIONS = [
  "screenRecording",
  "accessibility",
  "input",
] as const satisfies readonly DesktopComputerPermission[];

export function missingDesktopComputerPermissions(
  state: Pick<DesktopComputerUseState, "permissions">,
): DesktopComputerPermission[] {
  return DESKTOP_COMPUTER_PERMISSIONS.filter(
    (permission) => state.permissions[permission] !== "granted",
  );
}

export function hasMacOs15InputMonitoringPane(macosVersion: string | null): boolean {
  if (macosVersion === null) return false;
  const major = Number.parseInt(macosVersion.split(".", 1)[0] ?? "", 10);
  return Number.isFinite(major) && major >= 15;
}

export type DesktopComputerControlIndicatorState = "ready" | "waiting" | "unsupported" | "stopped";

export function desktopComputerControlIndicatorState(
  state: DesktopComputerUseState | null,
  agentSupportsComputerControl: boolean,
): DesktopComputerControlIndicatorState | null {
  if (state === null || !state.supported || !state.enabled) return null;
  if (state.stopped) return "stopped";
  if (!agentSupportsComputerControl) return "unsupported";
  return state.ready ? "ready" : "waiting";
}
