import { ServerIcon } from "lucide-react";
import { useTranslation } from "../../i18n";
import { usePrimaryEnvironment } from "../../state/environments";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarConnections() {
  const { t } = useTranslation();
  const environment = usePrimaryEnvironment();
  if (!window.coxDesktop?.openConnections) return null;
  return (
    <SidebarMenuItem grow>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label={t("Connections")}
              size="utility"
              onClick={() => {
                void window.coxDesktop?.openConnections?.().catch(() => {
                  toastManager.add({ type: "error", title: t("Could not open connections") });
                });
              }}
            />
          }
        >
          <ServerIcon />
          <span className="md:hidden">{environment?.label ?? t("Connections")}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          {environment ? `${environment.label} · ${t("Connections")}` : t("Connections")}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}
