import { useState } from "react";
import { EyeOffIcon, MoreHorizontalIcon, RefreshCcwIcon, RotateCcwIcon } from "lucide-react";
import { useDesktopBackendUpdate } from "../../hooks/useDesktopBackendUpdate";
import { useDesktopClientUpdate } from "../../hooks/useDesktopClientUpdate";
import { useTranslation } from "../../i18n";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopUpdates() {
  const { t } = useTranslation();
  const backend = useDesktopBackendUpdate();
  const client = useDesktopClientUpdate();
  const [applying, setApplying] = useState(false);
  const backendState = backend.state;
  const clientState = client.state;
  if (!backendState) return null;

  const clientNeedsDownload =
    clientState !== null &&
    (clientState.status === "available" ||
      (clientState.status === "error" && clientState.latestVersion !== null));
  const backendNeedsDownload =
    backendState.status === "available" ||
    (backendState.status === "error" && backendState.latestVersion !== null);
  const busy =
    applying ||
    clientState?.status === "checking" ||
    clientState?.status === "downloading" ||
    backendState.status === "checking" ||
    backendState.status === "installing";
  const showRestore =
    clientState?.automaticChecks === false ||
    typeof clientState?.ignoredVersion === "string" ||
    backendState.automaticChecks === false ||
    backendState.ignoredVersion !== null;
  const showCheckInMenu = clientNeedsDownload || backendNeedsDownload;
  const canIgnoreBackend = window.coxDesktop?.setBackendUpdatePolicy !== undefined;
  const showMenu = showCheckInMenu || showRestore;
  const clientUpdateVersion =
    clientState?.latestVersion &&
    clientState.latestVersion !== clientState.currentVersion &&
    clientState.status !== "idle"
      ? clientState.latestVersion
      : null;
  const description =
    clientState?.status === "ready"
      ? t(
          clientState?.installMode === "automatic"
            ? "The client update is ready. Restart when your tasks are finished."
            : "The installer is ready. Open it to finish updating the client.",
        )
      : backendState.status === "ready"
        ? t(
            "Cox is downloaded. It will activate on the next launch without interrupting current tasks.",
          )
        : clientState?.status === "available"
          ? t("Cox Desktop {version} is available.", {
              version: clientState?.latestVersion ?? "",
            })
          : backendState.status === "available"
            ? t("Cox {version} is available.", { version: backendState.latestVersion ?? "" })
            : clientState?.status === "downloading"
              ? t("Downloading client update…")
              : backendState.status === "installing"
                ? t("Downloading and verifying Cox…")
                : clientState?.status === "checking" || backendState.status === "checking"
                  ? t("Checking for updates…")
                  : clientState?.status === "error"
                    ? t(clientState?.message ?? "Could not update the client.")
                    : backendState.status === "error"
                      ? t(backendState.message ?? "Could not update Cox.")
                      : backendState.status === "incompatible"
                        ? t("This Cox update requires a newer desktop client.")
                        : clientState?.automaticChecks === false ||
                            backendState.automaticChecks === false
                          ? t("Automatic update checks are disabled. You can still check manually.")
                          : clientState?.ignoredVersion
                            ? t(
                                "Client {version} is ignored. Newer versions will still be offered.",
                                {
                                  version: clientState?.ignoredVersion ?? "",
                                },
                              )
                            : backendState.ignoredVersion
                              ? t(
                                  "Cox {version} is ignored. Newer versions will still be offered.",
                                  {
                                    version: backendState.ignoredVersion,
                                  },
                                )
                              : clientState !== null &&
                                  clientState.latestVersion === clientState.currentVersion &&
                                  backendState.latestVersion === backendState.currentVersion
                                ? t("The client and Cox are up to date.")
                                : t("The client checks for desktop and Cox updates automatically.");

  const checkAll = () => void Promise.all([client.check(), backend.check()]);
  const primary =
    clientState?.status === "ready" ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          setApplying(true);
          void client.apply().finally(() => setApplying(false));
        }}
      >
        {t(clientState?.installMode === "automatic" ? "Restart and update" : "Open installer")}
      </Button>
    ) : clientNeedsDownload || backendNeedsDownload ? (
      <Button
        size="sm"
        disabled={busy}
        onClick={() => {
          if (clientNeedsDownload && backendNeedsDownload)
            void Promise.all([client.download(), backend.install()]);
          else if (clientNeedsDownload) void client.download();
          else void backend.install();
        }}
      >
        {t(
          clientNeedsDownload && backendNeedsDownload
            ? "Download updates"
            : clientNeedsDownload
              ? clientState?.status === "error"
                ? "Retry"
                : "Download client update"
              : backendState.status === "error"
                ? "Retry"
                : "Download Cox update",
        )}
      </Button>
    ) : (
      <Button size="sm" variant="outline" disabled={busy} onClick={checkAll}>
        {t("Check for updates")}
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
                    <MenuItem
                      disabled={busy}
                      onClick={() =>
                        void Promise.all([
                          client.setPolicy("automatic"),
                          backend.setPolicy("automatic"),
                        ])
                      }
                    >
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
        {clientState?.progress ? (
          <DesktopUpdateProgress progress={clientState?.progress} />
        ) : backendState.progress ? (
          <DesktopUpdateProgress progress={backendState.progress} />
        ) : null}
      </SettingsRow>
      <SettingsRow
        title={t("Automatic update checks")}
        control={
          <Switch
            aria-label={t("Automatic update checks")}
            checked={
              clientState?.automaticChecks !== false && backendState.automaticChecks !== false
            }
            disabled={busy}
            onCheckedChange={(checked) =>
              void Promise.all([
                client.setPolicy(checked ? "automatic" : "never"),
                backend.setPolicy(checked ? "automatic" : "never"),
              ])
            }
          />
        }
      />
    </SettingsSection>
  );
}
