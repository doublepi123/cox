import { useState } from "react";
import { EyeOffIcon, MoreHorizontalIcon, RefreshCcwIcon, RotateCcwIcon } from "lucide-react";
import { useDesktopClientUpdate } from "../../hooks/useDesktopClientUpdate";
import { useTranslation } from "../../i18n";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

export function DesktopClientUpdates() {
  const { t } = useTranslation();
  const { state, check, download, apply, setPolicy } = useDesktopClientUpdate();
  const [applying, setApplying] = useState(false);
  if (!state) return null;
  const busy = applying || state.status === "checking" || state.status === "downloading";
  const showCheckInMenu =
    state.status === "available" || (state.status === "error" && state.latestVersion !== null);
  const showRestore = state.automaticChecks === false || state.ignoredVersion !== null;
  const showMenu = showCheckInMenu || showRestore;
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
          <div className="flex items-center gap-1.5">
            {state.status === "ready" ? (
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
            ) : state.status === "available" ||
              (state.status === "error" && state.latestVersion !== null) ? (
              <Button size="sm" disabled={busy} onClick={() => void download()}>
                {t(state.status === "error" ? "Retry" : "Download client update")}
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void check()}>
                {t("Check for client updates")}
              </Button>
            )}
            {showMenu ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      disabled={busy}
                      aria-label={t("Client update actions")}
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </MenuTrigger>
                <MenuPopup align="end">
                  {showCheckInMenu ? (
                    <MenuItem disabled={busy} onClick={() => void check()}>
                      <RefreshCcwIcon />
                      {t("Check for client updates")}
                    </MenuItem>
                  ) : null}
                  {showRestore ? (
                    <MenuItem disabled={busy} onClick={() => void setPolicy("automatic")}>
                      <RotateCcwIcon />
                      {t("Restore automatic client update checks")}
                    </MenuItem>
                  ) : null}
                  {state.status === "available" ? (
                    <MenuItem
                      onClick={() =>
                        void setPolicy("ignore-version", state.latestVersion ?? undefined)
                      }
                    >
                      <EyeOffIcon />
                      {t("Ignore this version")}
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
