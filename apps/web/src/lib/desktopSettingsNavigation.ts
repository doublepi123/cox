import type { RouterHistory } from "@tanstack/react-router";
import type { DesktopShellBridge } from "@t3tools/contracts";

export function startDesktopSettingsNavigation(
  history: RouterHistory,
  bridge: DesktopShellBridge | undefined,
  onError: (error: unknown) => void,
): (() => void) | undefined {
  if (!bridge?.openSettings || !bridge.windowKind) return;
  return history.block({
    enableBeforeUnload: false,
    blockerFn: ({ nextLocation }) => {
      const settings =
        nextLocation.pathname === "/settings" || nextLocation.pathname.startsWith("/settings/");
      const open =
        bridge.windowKind === "main" && settings
          ? bridge.openSettings
          : bridge.windowKind === "settings" && !settings
            ? bridge.openMain
            : undefined;
      if (!open) return false;
      void open(nextLocation.href).catch(onError);
      return true;
    },
  });
}
