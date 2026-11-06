import { useDesktopBackendUpdate } from "../../hooks/useDesktopBackendUpdate";
import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DesktopBackendUpdates() {
  const { t } = useTranslation();
  const { state, check, install } = useDesktopBackendUpdate();
  if (!state) return null;
  const busy = state.status === "checking" || state.status === "installing";
  return (
    <SettingsSection title={t("Desktop client")}>
      <SettingsRow title={t("Client version")} control={<code>{state.desktopVersion}</code>} />
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
                    ? (state.message ?? t("Could not update Cox."))
                    : state.status === "checking"
                      ? t("Checking for Cox updates…")
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
            {state.status === "available" && (
              <Button size="sm" onClick={() => void install()}>
                {t("Download Cox update")}
              </Button>
            )}
          </div>
        }
      />
    </SettingsSection>
  );
}
