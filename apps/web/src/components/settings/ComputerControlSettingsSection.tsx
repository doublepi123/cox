import type { DesktopComputerPermission, DesktopComputerUseState } from "@t3tools/contracts";
import { CheckCircle2Icon, CircleAlertIcon, CircleHelpIcon } from "lucide-react";
import { useState } from "react";
import { useDesktopComputerUse } from "../../hooks/useDesktopComputerUse";
import { useTranslation } from "../../i18n";
import {
  DESKTOP_COMPUTER_PERMISSION_LABELS,
  hasMacOs15InputMonitoringPane,
  missingDesktopComputerPermissions,
} from "../../lib/desktopComputerUse";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function permissionNames(
  permissions: readonly DesktopComputerPermission[],
  translate: (key: string) => string,
): string {
  return permissions
    .map((permission) => translate(DESKTOP_COMPUTER_PERMISSION_LABELS[permission]))
    .join(", ");
}

function PermissionGuideRow({
  permission,
  state,
  checking,
  onOpenSettings,
}: {
  readonly permission: DesktopComputerPermission;
  readonly state: DesktopComputerUseState;
  readonly checking: boolean;
  readonly onOpenSettings: (permission: DesktopComputerPermission) => void;
}) {
  const { t } = useTranslation();
  const status = state.permissions[permission];
  const label = t(DESKTOP_COMPUTER_PERMISSION_LABELS[permission]);
  const description =
    permission === "screenRecording"
      ? t("Lets Cox see the screen and window content.")
      : permission === "accessibility"
        ? t(
            "Lets Cox read interface elements and operate windows, including sending clicks and keys.",
          )
        : hasMacOs15InputMonitoringPane(state.macosVersion)
          ? t(
              "On macOS 15+, open Privacy & Security → Input Monitoring. Input control uses the Accessibility grant; Input Monitoring lets Control+Option+Command+Escape stop input from any app.",
            )
          : t(
              "Input control uses the Accessibility grant. Input Monitoring lets Control+Option+Command+Escape stop input from any app.",
            );
  return (
    <li className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <h3 className="text-sm font-medium text-foreground">{label}</h3>
          <span
            className={
              status === "granted" && !checking
                ? "inline-flex items-center gap-1 text-xs text-success-foreground"
                : "inline-flex items-center gap-1 text-xs text-warning-foreground"
            }
          >
            {checking ? (
              <Spinner size="sm" tone="muted" />
            ) : status === "granted" ? (
              <CheckCircle2Icon aria-hidden className="size-3.5" />
            ) : status === "denied" ? (
              <CircleAlertIcon aria-hidden className="size-3.5" />
            ) : (
              <CircleHelpIcon aria-hidden className="size-3.5" />
            )}
            {checking
              ? t("Checking…")
              : status === "granted"
                ? t("Granted")
                : status === "denied"
                  ? t("Missing")
                  : t("Unknown")}
          </span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>
        <p className="text-xs text-foreground/75">
          {t("Authorize {appName} for {permission}", {
            appName: state.appName,
            permission: label,
          })}
        </p>
        {state.appPath ? (
          <code dir="ltr" className="block wrap-anywhere text-xs text-muted-foreground">
            {state.appPath}
          </code>
        ) : null}
      </div>
      {status !== "granted" && window.coxDesktop?.openComputerUseSettings ? (
        <div className="shrink-0">
          <Button
            size="sm"
            variant="outline"
            aria-label={t("Open System Settings for {permission}", { permission: label })}
            onClick={() => onOpenSettings(permission)}
          >
            {t("Open System Settings")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function ComputerControlSettingsSection() {
  const { t } = useTranslation();
  const computer = useDesktopComputerUse();
  const [guideOpen, setGuideOpen] = useState(false);
  const state = computer.state;
  if (!state?.supported || !window.coxDesktop?.getComputerUse) return null;
  const missing = missingDesktopComputerPermissions(state);
  const missingNames = permissionNames(missing, t);
  const engineMessage =
    state.engine === "missing"
      ? t("Computer control engine is missing.")
      : state.engine === "downloading"
        ? t("Downloading the computer control engine…")
        : state.engine === "error"
          ? t("Computer control engine error")
          : null;
  const enabledSwitch = (
    <Switch
      checked={state.enabled}
      disabled={!window.coxDesktop.setComputerUseEnabled}
      aria-label={t("Computer control")}
      onCheckedChange={(checked) => {
        if (checked) setGuideOpen(true);
        else setGuideOpen(false);
        void computer.setEnabled(checked);
      }}
    />
  );
  const hasSecondaryAction = state.stopped || (state.enabled && !state.ready);
  return (
    <>
      <SettingsSection title={t("Computer control")}>
        <SettingsRow
          {...searchableSetting("computer-control")}
          description={t(
            "Allow Cox to see the screen and control this Mac with a compatible agent.",
          )}
          status={
            state.stopped ? (
              <p className="text-warning-foreground">{t("Computer control was stopped")}</p>
            ) : state.ready ? (
              <p className="text-success-foreground">{t("Ready to use computer control")}</p>
            ) : state.enabled ? (
              <div className="space-y-0.5">
                <p className="text-warning-foreground">{t("Enabled, waiting for permission")}</p>
                {missing.length > 0 ? (
                  <p>{t("Missing: {permissions}", { permissions: missingNames })}</p>
                ) : null}
              </div>
            ) : null
          }
          control={
            hasSecondaryAction ? (
              <div className="flex items-center justify-end gap-2">
                {state.stopped ? (
                  <Button size="sm" variant="outline" onClick={() => void computer.resume()}>
                    {t("Resume")}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setGuideOpen(true)}>
                    {t("Set up permissions")}
                  </Button>
                )}
                {enabledSwitch}
              </div>
            ) : (
              enabledSwitch
            )
          }
        >
          {computer.error ? (
            <p className="pt-2 text-xs text-destructive" role="alert">
              {computer.error}
            </p>
          ) : null}
        </SettingsRow>
      </SettingsSection>
      <Dialog open={guideOpen} onOpenChange={setGuideOpen}>
        <DialogPopup width="xl" bottomStickOnMobile={false}>
          <DialogHeader>
            <DialogTitle>{t("Set up computer control")}</DialogTitle>
            <DialogDescription>
              {t(
                "Authorize {appName} in macOS Privacy & Security. You can finish these permissions later.",
                { appName: state.appName },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {state.restartRequired ? (
              <div className="flex flex-col gap-3 rounded-lg bg-warning-surface p-3 text-warning-foreground sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs leading-relaxed" role="alert">
                  {t("macOS requires quitting and reopening Cox for the grant to take effect.")}
                </p>
                {window.coxDesktop.restartForComputerUse ? (
                  <Button
                    size="sm"
                    variant="warning-outline"
                    onClick={() => void computer.restart()}
                  >
                    {t("Restart Cox")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {engineMessage ? (
              <div className="space-y-1 text-xs" role="status">
                <p
                  className={
                    state.engine === "error" ? "text-destructive" : "text-warning-foreground"
                  }
                >
                  {engineMessage}
                </p>
                {state.engineMessage ? (
                  <p className="wrap-anywhere text-muted-foreground">{state.engineMessage}</p>
                ) : null}
              </div>
            ) : null}
            <ul className="divide-y divide-border/60">
              {(["screenRecording", "accessibility", "input"] as const).map((permission) => (
                <PermissionGuideRow
                  key={permission}
                  permission={permission}
                  state={state}
                  checking={computer.checking}
                  onOpenSettings={(next) => void computer.openSettings(next)}
                />
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter variant="bare" layout="between">
            <Button
              size="sm"
              variant="ghost-muted"
              disabled={computer.checking || !window.coxDesktop.recheckComputerUse}
              onClick={() => void computer.recheck()}
            >
              <span className={computer.checking ? "opacity-0" : undefined}>{t("Re-check")}</span>
              {computer.checking ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <Spinner size="sm" tone="muted" />
                </span>
              ) : null}
            </Button>
            <DialogClose render={<Button size="sm" variant="outline" />}>
              {t("Set up later")}
            </DialogClose>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
