import { EyeOffIcon, MoreHorizontalIcon, RefreshCcwIcon, RotateCcwIcon } from "lucide-react";
import { useDesktopSoftwareUpdate } from "../../hooks/useDesktopSoftwareUpdate";
import { useTranslation } from "../../i18n";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopUpdates() {
  const { t } = useTranslation();
  const updates = useDesktopSoftwareUpdate();
  const { backend, client, plan, busy } = updates;
  const backendState = backend.state;
  const clientState = client.state;
  if (!backendState) return null;

  const showRestore =
    clientState?.automaticChecks === false ||
    typeof clientState?.ignoredVersion === "string" ||
    backendState.automaticChecks === false ||
    typeof backendState.ignoredVersion === "string";
  const showCheckInMenu = plan.status === "available" || plan.status === "error";
  const canIgnoreBackend = window.coxDesktop?.setBackendUpdatePolicy !== undefined;
  const showMenu = showCheckInMenu || showRestore;
  const canApplyBackendUpdate =
    window.coxDesktop?.applyUpdates !== undefined ||
    window.coxDesktop?.applyBackendUpdate !== undefined;
  const clientUpdateVersion =
    clientState?.latestVersion &&
    clientState.latestVersion !== clientState.currentVersion &&
    clientState.status !== "idle"
      ? clientState.latestVersion
      : null;
  const description = updates.error
    ? t("Could not finish updating. Check for updates again.")
    : plan.status === "checking"
      ? t("Checking for updates…")
      : plan.status === "downloading"
        ? t("Downloading and verifying updates. Current tasks will not be interrupted.")
        : plan.status === "error"
          ? t("Could not finish updating. Check for updates again.")
          : plan.status === "available"
            ? t("Updates are available. Download them together without interrupting current tasks.")
            : plan.status === "incompatible"
              ? t("This Cox update requires a newer desktop client.")
              : plan.status === "ready" && backendState.status === "incompatible"
                ? t("Update the client first; Cox will be checked again after relaunch.")
                : plan.status === "ready" && clientState?.status === "ready"
                  ? t(
                      clientState?.installMode === "automatic"
                        ? "Updates are ready to install."
                        : "The installer is ready. Open it to finish updating the client.",
                    )
                  : plan.status === "ready"
                    ? canApplyBackendUpdate
                      ? t(
                          "Cox {version} is downloaded. Update now to restart Cox, or activate it on the next launch.",
                          { version: backendState.latestVersion ?? "" },
                        )
                      : t(
                          "Cox is downloaded. It will activate on the next launch without interrupting current tasks.",
                        )
                    : !plan.automaticChecks
                      ? t("Automatic update checks are disabled. You can still check manually.")
                      : clientState?.ignoredVersion
                        ? t("Client {version} is ignored. Newer versions will still be offered.", {
                            version: clientState?.ignoredVersion ?? "",
                          })
                        : backendState.ignoredVersion
                          ? t("Cox {version} is ignored. Newer versions will still be offered.", {
                              version: backendState.ignoredVersion,
                            })
                          : plan.status === "current"
                            ? t("The client and Cox are up to date.")
                            : t("The client checks for desktop and Cox updates automatically.");

  const checkAll = () => void updates.check();
  const primary =
    plan.status === "ready" && (plan.clientReady || canApplyBackendUpdate) ? (
      <Button size="sm" disabled={busy} onClick={() => void updates.apply()}>
        {t(
          plan.clientReady
            ? clientState?.installMode === "automatic"
              ? "Restart and update"
              : "Open installer"
            : "Update now",
        )}
      </Button>
    ) : plan.status === "available" || plan.status === "error" ? (
      <Button size="sm" disabled={busy} onClick={() => void updates.download()}>
        {t(plan.status === "error" ? "Retry" : "Download updates")}
      </Button>
    ) : (
      <Button size="sm" variant="outline" disabled={busy} onClick={checkAll}>
        {t(
          plan.status === "checking"
            ? "Checking for updates…"
            : plan.status === "downloading"
              ? "Download updates"
              : "Check for updates",
        )}
      </Button>
    );

  return (
    <SettingsSection title={t("Desktop client")}>
      <SettingsRow
        title={t("Client version")}
        control={<code>{backendState.desktopVersion}</code>}
      />
      {clientUpdateVersion ? (
        <SettingsRow
          title={t("Client update version")}
          control={<code>{clientUpdateVersion}</code>}
        />
      ) : null}
      <SettingsRow
        title={t("Installed Cox version")}
        control={<code>{backendState.currentVersion ?? "—"}</code>}
      />
      {backendState.latestVersion &&
      backendState.latestVersion !== backendState.currentVersion &&
      backendState.status !== "idle" ? (
        <SettingsRow
          title={t("Cox update version")}
          control={<code>{backendState.latestVersion}</code>}
        />
      ) : null}
      <SettingsRow
        title={t("Bundled Cox version")}
        control={<code>{backendState.bundledVersion ?? t("Not bundled")}</code>}
      />
      <SettingsRow
        title={t("Software updates")}
        description={description}
        control={
          <div className="flex items-center gap-1.5">
            {primary}
            {showMenu ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("Update actions")}
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {showCheckInMenu ? (
                    <MenuItem disabled={busy} onClick={checkAll}>
                      <RefreshCcwIcon />
                      {t("Check for updates")}
                    </MenuItem>
                  ) : null}
                  {clientState?.status === "available" ? (
                    <MenuItem
                      disabled={busy}
                      onClick={() =>
                        void client.setPolicy(
                          "ignore-version",
                          clientState?.latestVersion ?? undefined,
                        )
                      }
                    >
                      <EyeOffIcon />
                      {t("Ignore this client version")}
                    </MenuItem>
                  ) : null}
                  {canIgnoreBackend && backendState.status === "available" ? (
                    <MenuItem
                      disabled={busy}
                      onClick={() =>
                        void backend.setPolicy(
                          "ignore-version",
                          backendState.latestVersion ?? undefined,
                        )
                      }
                    >
                      <EyeOffIcon />
                      {t("Ignore this Cox version")}
                    </MenuItem>
                  ) : null}
                  {showRestore ? (
                    <MenuItem disabled={busy} onClick={() => void updates.setPolicy("automatic")}>
                      <RotateCcwIcon />
                      {t("Restore automatic update checks")}
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        }
      >
        {updates.error ? (
          <p className="text-xs text-destructive" role="alert">
            {t(updates.error)}
          </p>
        ) : null}
        {clientState?.status === "error" ? (
          <p className="text-xs text-destructive" role="alert">
            {t("Desktop client")}: {t(clientState.message ?? "Could not update the client.")}
          </p>
        ) : null}
        {backendState.status === "error" ? (
          <p className="text-xs text-destructive" role="alert">
            Cox: {t(backendState.message ?? "Could not update Cox.")}
          </p>
        ) : null}
        {clientState?.progress ? (
          <div>
            <p className="text-xs text-muted-foreground">{t("Desktop client")}</p>
            <DesktopUpdateProgress progress={clientState.progress} />
          </div>
        ) : null}
        {backendState.progress ? (
          <div>
            <p className="text-xs text-muted-foreground">Cox</p>
            <DesktopUpdateProgress progress={backendState.progress} />
          </div>
        ) : null}
      </SettingsRow>
      <SettingsRow
        title={t("Automatic update checks")}
        description={t("Check for client and Cox updates together.")}
        control={
          <Switch
            aria-label={t("Automatic update checks")}
            checked={plan.automaticChecks}
            disabled={busy}
            onCheckedChange={(checked) => void updates.setPolicy(checked ? "automatic" : "never")}
          />
        }
      />
    </SettingsSection>
  );
}
