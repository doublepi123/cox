import { useDesktopBackendUpdate } from "../../hooks/useDesktopBackendUpdate";
import { MoreHorizontalIcon, RefreshCcwIcon, RotateCcwIcon } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { DesktopClientUpdates } from "./DesktopClientUpdates";

export function DesktopBackendUpdates() {
  const { t } = useTranslation();
  const { state, check, install, setPolicy } = useDesktopBackendUpdate();
  if (!state) return null;
  const busy = state.status === "checking" || state.status === "installing";
  const showCheckInMenu =
    state.status === "available" || (state.status === "error" && Boolean(state.latestVersion));
  const showRestore =
    window.coxDesktop?.setBackendUpdatePolicy !== undefined &&
    (state.automaticChecks === false || Boolean(state.ignoredVersion));
  return (
    <SettingsSection title={t("Desktop client")}>
      <SettingsRow title={t("Client version")} control={<code>{state.desktopVersion}</code>} />
      <DesktopClientUpdates />
      <SettingsRow
        title={t("Installed Cox version")}
        control={<code>{state.currentVersion ?? "—"}</code>}
      />
      <SettingsRow
        title={t("Bundled Cox version")}
        control={<code>{state.bundledVersion ?? t("Not bundled")}</code>}
      />
      <SettingsRow
        title={t("Cox backend updates")}
        description={
          state.status === "ready"
            ? t(
                "Cox is downloaded. It will activate on the next launch without interrupting current tasks.",
              )
            : state.status === "installing"
              ? t("Downloading and verifying Cox…")
              : state.status === "incompatible"
                ? t("This Cox update requires a newer desktop client.")
                : state.status === "available"
                  ? t("Cox {version} is available.", { version: state.latestVersion ?? "" })
                  : state.status === "error"
                    ? t(state.message ?? "Could not update Cox.")
                    : state.status === "checking"
                      ? t("Checking for Cox updates…")
                      : state.automaticChecks === false
                        ? t(
                            "Automatic Cox update checks are disabled. You can still check manually.",
                          )
                        : state.ignoredVersion
                          ? t("Cox {version} is ignored. Newer versions will still be offered.", {
                              version: state.ignoredVersion,
                            })
                          : t("The client checks for Cox updates automatically.")
        }
        control={
          <div className="flex items-center gap-1.5">
            {state.status === "available" || (state.status === "error" && state.latestVersion) ? (
              <Button size="sm" onClick={() => void install()}>
                {t(state.status === "error" ? "Retry" : "Download Cox update")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || state.status === "ready"}
                onClick={() => void check()}
              >
                {t("Check for Cox updates")}
              </Button>
            )}
            {showCheckInMenu || showRestore ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("Cox update actions")}
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {showCheckInMenu ? (
                    <MenuItem disabled={busy} onClick={() => void check()}>
                      <RefreshCcwIcon />
                      {t("Check for Cox updates")}
                    </MenuItem>
                  ) : null}
                  {showRestore ? (
                    <MenuItem disabled={busy} onClick={() => void setPolicy("automatic")}>
                      <RotateCcwIcon />
                      {t("Restore automatic Cox update checks")}
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
        }
      >
        {state.progress && <DesktopUpdateProgress progress={state.progress} />}
      </SettingsRow>
    </SettingsSection>
  );
}
