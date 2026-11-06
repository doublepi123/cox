import { useDesktopBackendUpdate } from "../../hooks/useDesktopBackendUpdate";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { DesktopClientUpdates } from "./DesktopClientUpdates";

export function DesktopBackendUpdates() {
  const { t } = useTranslation();
  const { state, check, install, setPolicy } = useDesktopBackendUpdate();
  if (!state) return null;
  const busy = state.status === "checking" || state.status === "installing";
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
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || state.status === "ready"}
              onClick={() => void check()}
            >
              {t("Check for Cox updates")}
            </Button>
            {(state.status === "available" ||
              (state.status === "error" && state.latestVersion)) && (
              <Button size="sm" onClick={() => void install()}>
                {t(state.status === "error" ? "Retry" : "Download Cox update")}
              </Button>
            )}
            {window.coxDesktop?.setBackendUpdatePolicy &&
              (state.automaticChecks === false || state.ignoredVersion) && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void setPolicy("automatic")}
                >
                  {t("Restore automatic Cox update checks")}
                </Button>
              )}
          </div>
        }
      >
        {state.progress && <DesktopUpdateProgress progress={state.progress} />}
      </SettingsRow>
    </SettingsSection>
  );
}
