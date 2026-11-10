import type { RouterHistory } from "@tanstack/react-router";
import type { DesktopShellBridge } from "@t3tools/contracts";

export function isDesktopPageWindow(bridge: DesktopShellBridge | undefined): boolean {
  return bridge?.windowKind === "settings" || bridge?.windowKind === "usage";
}

export function startDesktopSettingsNavigation(
  history: RouterHistory,
  bridge: DesktopShellBridge | undefined,
  onError: (error: unknown) => void,
): (() => void) | undefined {
  if (!bridge?.windowKind) return;
  return history.block({
    enableBeforeUnload: false,
    blockerFn: ({ nextLocation }) => {
      const settings =
        nextLocation.pathname === "/settings" || nextLocation.pathname.startsWith("/settings/");
      const usage = nextLocation.pathname === "/usage";
      const open =
        settings && bridge.windowKind !== "settings"
          ? bridge.openSettings
          : usage && bridge.windowKind !== "usage"
            ? (bridge.openUsage ?? (isDesktopPageWindow(bridge) ? bridge.openMain : undefined))
            : isDesktopPageWindow(bridge) && !settings && !usage
              ? bridge.openMain
              : undefined;
      if (!open) return false;
      void open(nextLocation.href).catch(onError);
      return true;
    },
  });
}
