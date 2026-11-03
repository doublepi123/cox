import { useTranslation } from "../i18n";
import { workspaceAreaProps } from "../lib/workspaceFocus";
import { Outlet, createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { useSettingsRestore } from "../components/settings/SettingsPanels";

import { AppRouteModal, AppRouteModalClose } from "../components/AppRouteModal";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import {
  SettingsScopeProvider,
  useSettingsScope,
} from "../components/settings/SettingsScopeContext";
import { useEnvironments } from "../state/environments";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { SettingsScopeNotice } from "../components/settings/SettingsScopeNotice";
import { SETTINGS_DEVICE_ONLY_PATHS } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import {
  retainSettingsScope,
  validateSettingsRouteSearch,
} from "../components/settings/settingsScopeNavigation";
import {
  getSettingsSearchTargetScope,
  getThreadAutoSettlementSearchAvailability,
  isSettingsSearchScopeAvailable,
  movedSettingsPath,
  SETTINGS_SECTION_LABELS,
  type SettingsPath,
} from "../components/settings/settingsSearch";

function isSettingsIndexPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === "/settings";
}

function RestoreDeviceDefaultsButton({
  compact,
  onRestored,
}: {
  compact: boolean;
  onRestored: () => void;
}) {
  const { t } = useTranslation();
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(onRestored);
  return (
    <Button
      size={compact ? "icon-xl" : "xs"}
      variant="ghost"
      aria-label={t("Restore device defaults")}
      disabled={changedSettingLabels.length === 0}
      onClick={() => void restoreDefaults()}
    >
      <RotateCcwIcon className="mx-1 size-3.5" />
      <span className="max-sm:sr-only">{t("Restore device defaults")}</span>
    </Button>
  );
}

function SettingsScopeBoundary({ pathname, children }: { pathname: string; children: ReactNode }) {
  const { t } = useTranslation();
  const { scope, connectedEnvironments } = useSettingsScope();
  const { environments } = useEnvironments();
  const hash = useLocation({ select: (location) => location.hash });
  const searchTarget = getSettingsSearchTargetScope(hash);
  const autoSettlementAvailability = searchTarget?.requiresThreadAutoSettlement
    ? getThreadAutoSettlementSearchAvailability(environments, scope)
    : null;
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    autoSettlementAvailability &&
    !autoSettlementAvailability.isTargetAvailable
  ) {
    return (
      <SettingsScopeNotice
        target="environment"
        targetId={hash}
        eligibleEnvironmentIds={autoSettlementAvailability.eligibleEnvironmentIds}
      >
        {autoSettlementAvailability.eligibleEnvironmentIds.length > 0
          ? `${searchTarget.title} requires a supporting environment. Choose one to continue.`
          : `${searchTarget.title} requires a supporting environment. Connect or update an environment to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (
    scope.kind !== "unavailable" &&
    searchTarget &&
    !isSettingsSearchScopeAvailable(searchTarget.scope, scope.kind)
  ) {
    const target =
      searchTarget.scope === "environment" ||
      searchTarget.scope === "project" ||
      searchTarget.scope === "checkout"
        ? searchTarget.scope
        : "all";
    return (
      <SettingsScopeNotice target={target} targetId={hash}>
        {`${searchTarget.title} is not available for the selected target. Choose its owning scope to continue.`}
      </SettingsScopeNotice>
    );
  }
  if (SETTINGS_DEVICE_ONLY_PATHS.has(pathname) || pathname === "/settings/projects") {
    return children;
  }
  if (scope.kind === "unavailable")
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">{scope.message}</p>
      </SettingsPageContainer>
    );
  if (scope.kind === "environment" && connectedEnvironments.length === 0) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {t("Reconnect")}
          {scope.label} to change its settings.
        </p>
      </SettingsPageContainer>
    );
  }
  return children;
}

function SettingsContentLayout() {
  const { t } = useTranslation();
  const contentArea = workspaceAreaProps("settings", 1, "Settings content");
  const location = useLocation();
  const navigate = useNavigate();
  const { search, environment } = useSettingsScope();
  const contentScopeKey =
    location.pathname === "/settings/diagnostics" ||
    location.pathname === "/settings/providers" ||
    location.pathname === "/settings/model-services"
      ? environment?.environmentId
      : JSON.stringify(search);
  const [restoreSignal, setRestoreSignal] = useState(0);
  const isPhoneLayout = useMediaQuery("max-sm");
  const isSettingsIndex = isSettingsIndexPath(location.pathname);
  const normalizedPath = location.pathname.replace(/\/+$/, "") || "/";
  const phoneSectionLabel =
    isPhoneLayout && !isSettingsIndex
      ? (SETTINGS_SECTION_LABELS[normalizedPath as SettingsPath] ??
        (normalizedPath === "/settings/open-source-licenses" ? "Open source licenses" : null))
      : null;

  // Desktop keeps the old default landing; phone uses /settings as the section menu.
  useEffect(() => {
    if (isPhoneLayout || !isSettingsIndex) return;
    void navigate({ to: "/settings/general", replace: true, search: true });
  }, [isPhoneLayout, isSettingsIndex, navigate]);

  return (
    <AppRouteModal label={t("Settings")}>
      <div className="relative flex min-h-0 flex-1">
        {isPhoneLayout ? null : <SettingsSidebarNav pathname={location.pathname} />}
        <div {...contentArea} className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header
            className={cn(
              "flex h-12 shrink-0 items-center gap-2 border-b pe-2 sm:gap-3 sm:ps-5",
              isPhoneLayout && phoneSectionLabel ? "ps-2" : "ps-4",
            )}
          >
            {isPhoneLayout && phoneSectionLabel ? (
              <>
                <Button
                  type="button"
                  size="icon-xl"
                  variant="ghost"
                  aria-label={t("Back")}
                  onClick={() =>
                    void navigate({ to: "/settings", replace: true, search: true, hash: "" })
                  }
                >
                  <ArrowLeftIcon />
                </Button>
                <div className="min-w-0 flex-1 truncate text-sm font-medium">
                  {t(phoneSectionLabel)}
                </div>
              </>
            ) : (
              <SettingsBreadcrumb
                pathname={location.pathname}
                showSection={!isPhoneLayout && !isSettingsIndex}
              />
            )}
            <div className="ms-auto flex shrink-0 items-center gap-1">
              {location.pathname === "/settings/general" ? (
                <RestoreDeviceDefaultsButton
                  compact={isPhoneLayout}
                  onRestored={() => setRestoreSignal((value) => value + 1)}
                />
              ) : null}
              <AppRouteModalClose size={isPhoneLayout ? "icon-xl" : "icon-sm"} />
            </div>
          </header>
          {isPhoneLayout && isSettingsIndex ? (
            <SettingsSidebarNav pathname={location.pathname} layout="menu" />
          ) : (
            <div
              key={`${contentScopeKey}:${restoreSignal}`}
              className="min-h-0 flex flex-1 flex-col"
            >
              <SettingsScopeBoundary pathname={location.pathname}>
                <Outlet />
              </SettingsScopeBoundary>
            </div>
          )}
        </div>
      </div>
    </AppRouteModal>
  );
}

function SettingsRouteLayout() {
  const rawSearch = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <SettingsScopeProvider
      search={rawSearch}
      singleEnvironment={
        pathname === "/settings/providers" ||
        pathname === "/settings/secrets" ||
        pathname === "/settings/model-services"
      }
      onChange={(next) => {
        // Send every axis so retain middleware recognizes "all" as an explicit target.
        void navigate({
          to: pathname,
          search: () => ({
            project: next.project,
            machine: next.machine,
            checkout: next.checkout,
          }),
          hash: "",
          resetScroll: false,
        });
      }}
    >
      <SettingsContentLayout />
    </SettingsScopeProvider>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  validateSearch: validateSettingsRouteSearch,
  search: { middlewares: [retainSettingsScope] },
  beforeLoad: async ({ location }) => {
    const moved = movedSettingsPath(location.pathname, location.hash);
    if (moved) throw redirect({ to: moved, search: true, hash: true, replace: true });
  },
  component: SettingsRouteLayout,
});
