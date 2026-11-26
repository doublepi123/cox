import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { useAtomValue } from "@effect/atom-react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { useTranslation } from "../../i18n";
import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { useLocalServiceUpdate } from "../../hooks/useLocalServiceUpdate";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import { primaryServerConfigAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { localServiceUpdateSupported } from "../settings/localServiceUpdateSupport";
import { CoxBrand } from "../CoxBrand";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";

import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { MobileServerSwitcher } from "../mobile/MobileServerSwitcher";
import { SidebarConnections } from "./SidebarConnections";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";
export const SidebarChromeHeader = memo(function SidebarChromeHeader() {
  const { t } = useTranslation();
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  return (
    <div
      data-workspace-titlebar
      className={cn(
        "relative flex h-14 shrink-0 flex-row items-center gap-2 px-3 [--workspace-titlebar-control-size:2.75rem] md:h-[var(--workspace-topbar-height)] md:pl-0",
        false,
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative order-last z-10 ml-auto flex shrink-0 items-center [&_button]:relative [&_button]:top-auto [&_button]:translate-y-0 md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          aria-label={t("Toggle main sidebar")}
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <div className="flex shrink-0 items-center gap-1">
          <SidebarBrand onBackdrop={backdropVariant !== null} />
          {null}
        </div>
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});
export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex gap-1">
        <SidebarBrandMark onBackdrop={false} />
        {null}
      </div>
    </div>
  );
}
function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Cox home"
      className={cn(
        "relative z-10 flex h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:ml-[var(--workspace-titlebar-content-left)]",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark onBackdrop={onBackdrop} />
    </Link>
  );
}
function SidebarBrandMark({ onBackdrop }: { onBackdrop: boolean }) {
  return <CoxBrand className={cn("text-sm", onBackdrop ? "text-white" : "text-foreground")} />;
}
function SidebarUtilityItem({
  icon,
  label,
  description,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  description?: string | undefined;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem grow>
      <SharedTooltipTrigger
        render={
          <SidebarMenuButton
            aria-label={description ? `${label}. ${description}` : label}
            onClick={onClick}
            size="utility"
          >
            {icon}
            <span className="md:hidden">{label}</span>
          </SidebarMenuButton>
        }
        side="top"
        label={description ?? label}
      />
    </SidebarMenuItem>
  );
}
const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const environment = useAtomValue(primaryServerConfigAtom)?.environment;
  const canMaintain = useEnvironmentScope(
    environment?.environmentId ?? null,
    AuthEnvironmentMaintainScope,
  );
  const canCheck = !isOnUtilityPage && localServiceUpdateSupported(environment) && canMaintain;
  const { state: update, error: updateError } = useLocalServiceUpdate(canCheck, 60_000);
  const updateVersion =
    canCheck && !updateError && (update?.status === "available" || update?.status === "ready")
      ? update.latestVersion
      : null;
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: updateVersion ? "/settings/about" : "/settings" });
  };
  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };
  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };
  return (
    <SidebarMenu layout="utilities">
      {isOnUtilityPage ? (
        <SidebarMenuItem grow>
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>{t("Back")}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarConnections />
          <MobileServerSwitcher />
          <SidebarUtilityItem
            icon={
              <span className="relative flex shrink-0">
                <SettingsIcon className="size-4" />
                {updateVersion ? (
                  <span
                    aria-hidden="true"
                    data-cox-update-reminder=""
                    className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary ring-1 ring-sidebar"
                  />
                ) : null}
              </span>
            }
            label={t("Settings")}
            description={
              updateVersion
                ? t("Cox {version} is available.", { version: updateVersion })
                : undefined
            }
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label={t("Pull requests")}
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label={t("Usage")}
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarThreadUndoNotice />
    </SidebarMenu>
  );
});
export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter mobileNavigation>
      <SidebarProviderUpdatePill />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
