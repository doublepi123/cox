import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type MobileNotificationSettingsPatch,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useTranslation } from "../../i18n";
import { useEnvironmentHttpBaseUrl } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { WebhookSettingsSection } from "./WebhookSettingsSection";
import { WebPushSettingsSection } from "./WebPushSettingsSection";

export function NotificationsSettingsPanel() {
  const { t } = useTranslation();
  const { environment, scope } = useSettingsScope();
  return (
    <SettingsPageContainer width="wide">
      {environment?.connection.phase === "connected" ? (
        <EnvironmentNotificationsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          projectScoped={scope.kind === "project" || scope.kind === "checkout"}
        />
      ) : (
        <SettingsSection title={t("Notifications")}>
          <SettingsRow title={t("Connect to Cox to manage notifications.")} />
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

export function EnvironmentNotificationsSettings({
  environmentId,
  projectScoped = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectScoped?: boolean;
}) {
  const { t } = useTranslation();
  const settings = useEnvironmentSettings(environmentId);
  const baseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const readOnly = !canManage || projectScoped;
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });

  const save = async (patch: MobileNotificationSettingsPatch) => {
    const result = await update({ environmentId, input: { patch: { notifications: patch } } });
    if (result._tag === "Success") return true;
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: t("Notification settings were not saved"),
        description:
          failure instanceof Error ? failure.message : t("Try saving notification settings again."),
      });
    }
    return false;
  };

  if (!baseUrl) {
    return (
      <SettingsSection title={t("Notifications")}>
        <SettingsRow title={t("Reconnect the selected environment to manage notifications.")} />
      </SettingsSection>
    );
  }
  return (
    <>
      <WebPushSettingsSection
        baseUrl={baseUrl}
        environmentId={environmentId}
        enabled={settings.notifications.webPushEnabled}
        readOnly={readOnly}
        onSave={(webPushEnabled) => save({ webPushEnabled })}
      />
      <WebhookSettingsSection
        baseUrl={baseUrl}
        channels={settings.notifications.webhooks}
        readOnly={readOnly}
        onSave={(webhooks) => save({ webhooks: [...webhooks] })}
      />
    </>
  );
}
