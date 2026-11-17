import { ServerIcon } from "lucide-react";

import { useTranslation } from "../../i18n";
import {
  openMobileServerSwitcher,
  triggerMobileHapticSelection,
  useMobileShellInfo,
} from "../../mobile/mobileShellBridge";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";

export function MobileServerSwitcher() {
  const { t } = useTranslation();
  const shellInfo = useMobileShellInfo();
  if (!shellInfo) return null;
  return (
    <SidebarMenuItem grow>
      <SidebarMenuButton
        data-mobile-server-switcher=""
        aria-label={`${t("Servers")}: ${shellInfo.activeServerLabel}`}
        size="utility"
        onClick={() => {
          triggerMobileHapticSelection();
          openMobileServerSwitcher();
        }}
      >
        <ServerIcon />
        <span className="flex min-w-0 max-w-full items-center justify-center gap-1 md:hidden">
          <span className="min-w-0 truncate">{shellInfo.activeServerLabel}</span>
          <span className="shrink-0 rounded-full bg-sidebar-control-surface px-1.5 text-2xs leading-4 tabular-nums">
            {shellInfo.serverCount}
          </span>
        </span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
