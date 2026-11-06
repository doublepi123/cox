import { useState } from "react";
import { useDesktopClientUpdate } from "../../hooks/useDesktopClientUpdate";
import { useTranslation } from "../../i18n";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function DesktopClientUpdates() {
  const { t } = useTranslation();
  const { state, check, download, apply, setPolicy } = useDesktopClientUpdate();
  const [applying, setApplying] = useState(false);
  if (!state) return null;
  const busy = applying || state.status === "checking" || state.status === "downloading";
  const description =
    state.status === "ready"
      ? t(
          state.installMode === "automatic"
            ? "The client update is ready. Restart when your tasks are finished."
            : "The installer is ready. Open it to finish updating the client.",
        )
      : state.status === "available"
        ? t("Cox Desktop {version} is available.", { version: state.latestVersion ?? "" })
        : state.status === "downloading"
          ? t("Downloading client update…")
          : state.status === "checking"
            ? t("Checking for client updates…")
            : state.status === "error"
              ? t(state.message ?? "Could not update the client.")
              : state.automaticChecks === false
                ? t("Automatic client update checks are disabled. You can still check manually.")
                : state.ignoredVersion
                  ? t("Client {version} is ignored. Newer versions will still be offered.", {
                      version: state.ignoredVersion,
                    })
                  : state.latestVersion === state.currentVersion
                    ? t("The client is up to date.")
                    : t("The client checks for new desktop versions automatically.");
  return (
    <>
      <SettingsRow
        title={t("Client updates")}
        description={description}
        control={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || state.status === "ready"}
              onClick={() => void check()}
            >
              {t("Check for client updates")}
            </Button>
            {(state.status === "available" ||
              (state.status === "error" && state.latestVersion !== null)) && (
              <Button size="sm" disabled={busy} onClick={() => void download()}>
                {t(state.status === "error" ? "Retry" : "Download client update")}
              </Button>
            )}
            {state.status === "ready" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  setApplying(true);
                  void apply().finally(() => setApplying(false));
                }}
              >
                {t(state.installMode === "automatic" ? "Restart and update" : "Open installer")}
              </Button>
            )}
            {(state.automaticChecks === false || state.ignoredVersion) && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void setPolicy("automatic")}
              >
                {t("Restore automatic client update checks")}
              </Button>
            )}
            {state.status === "available" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void setPolicy("ignore-version", state.latestVersion ?? undefined)}
              >
                {t("Ignore this version")}
              </Button>
            )}
          </div>
        }
      >
        {state.progress && <DesktopUpdateProgress progress={state.progress} />}
      </SettingsRow>
      <SettingsRow
        title={t("Automatic client update checks")}
        control={
          <Switch
            aria-label={t("Automatic client update checks")}
            checked={state.automaticChecks}
            disabled={busy}
            onCheckedChange={(checked) => void setPolicy(checked ? "automatic" : "never")}
          />
        }
      />
    </>
  );
}
