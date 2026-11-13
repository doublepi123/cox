import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { AuthEnvironmentMaintainScope } from "@t3tools/contracts";
import { primaryServerConfigAtom } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useLocalServiceUpdate } from "../../hooks/useLocalServiceUpdate";
import { localServiceUpdateSupported } from "./localServiceUpdateSupport";
import { useTranslation } from "../../i18n";
import { DesktopUpdateProgress } from "../DesktopUpdateProgress";
import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function LocalServiceUpdates() {
  const { t } = useTranslation();
  const config = useAtomValue(primaryServerConfigAtom);
  const environmentId = config?.environment.environmentId ?? null;
  const supported = localServiceUpdateSupported(config?.environment);
  const permitted = useEnvironmentScope(environmentId, AuthEnvironmentMaintainScope);
  const updates = useLocalServiceUpdate(supported && permitted);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const state = updates.state;
  if (!supported || !permitted || !state) return null;
  const busy = updates.busy || ["checking", "downloading", "restarting"].includes(state.status);
  const description = updates.error
    ? updates.error
    : state.status === "checking"
      ? t("Checking for updates…")
      : state.status === "downloading"
        ? t("Downloading and verifying Cox. Current tasks will not be interrupted.")
        : state.status === "restarting"
          ? t("Restarting Cox. This page will reconnect when it is ready.")
          : state.status === "ready"
            ? (state.message ??
              t("Cox {version} is downloaded and backed up. Restart to finish updating.", {
                version: state.latestVersion ?? "",
              }))
            : state.status === "available"
              ? t("Cox {version} is available.", { version: state.latestVersion ?? "" })
              : state.status === "error"
                ? state.message
                : state.status === "idle" && state.latestVersion
                  ? t("Cox is up to date.")
                  : t("Update the local Cox service from its official npm release.");

  return (
    <SettingsSection title={t("Current service")}>
      <SettingsRow
        {...searchableSetting("local-service-update")}
        title={t("Cox service updates")}
        description={description}
        control={
          state.status === "ready" ? (
            <Button size="sm" disabled={busy} onClick={() => setConfirmOpen(true)}>
              {t("Restart and update")}
            </Button>
          ) : state.status === "available" || state.status === "error" ? (
            <Button size="sm" disabled={busy} onClick={() => void updates.download()}>
              {t(state.status === "error" ? "Retry" : "Download update")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void updates.check()}
            >
              {t(state.status === "checking" ? "Checking for updates…" : "Check for updates")}
            </Button>
          )
        }
      >
        {state.progress ? <DesktopUpdateProgress progress={state.progress} /> : null}
        {state.backup ? (
          <p className="text-xs text-muted-foreground">
            {t("A database and settings backup is kept before restart.")}
          </p>
        ) : null}
      </SettingsRow>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Restart and update Cox?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                "Cox will briefly disconnect. Active agent turns must finish first. If the new version does not become healthy, the previous service will be restored.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />}>{t("Cancel")}</AlertDialogClose>
            <Button
              onClick={() => {
                setConfirmOpen(false);
                void updates.apply();
              }}
            >
              {t("Restart and update")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
