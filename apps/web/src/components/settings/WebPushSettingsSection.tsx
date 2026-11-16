import {
  getWebPushSupportState,
  subscribeBrowserToWebPush,
  unsubscribeBrowserFromWebPush,
} from "../../pwa/serviceWorkerRegistration";
import type { EnvironmentId, RegisteredPushSubscription } from "@t3tools/contracts";
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  deletePushSubscription,
  fetchPushSubscriptions,
  fetchVapidPublicKey,
  registerBrowserPushSubscription,
  sendTestNotification,
} from "./notificationsApi";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { WebPushSubscriptionsRow } from "./WebPushSubscriptionsRow";
import { WebPushSupportNotice } from "./WebPushSupportNotice";
import { useBrowserPushRegistration } from "./useBrowserPushRegistration";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface WebPushSettingsSectionProps {
  readonly baseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onSave: (enabled: boolean) => Promise<boolean>;
}

export function WebPushSettingsSection({
  baseUrl,
  environmentId,
  enabled,
  readOnly,
  onSave,
}: WebPushSettingsSectionProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const support = getWebPushSupportState();
  const {
    subscriptions,
    setSubscriptions,
    browserSubscription,
    setBrowserSubscription,
    setCurrentId,
    currentRegistration,
    loading,
    loadFailed,
  } = useBrowserPushRegistration({
    baseUrl,
    environmentId,
    supported: support.supported,
    readOnly,
    label: t("This browser"),
  });

  const changeDevice = async (nextEnabled: boolean) => {
    if (busy) return;
    setBusy("device");
    try {
      if (nextEnabled) {
        const vapid = await fetchVapidPublicKey(baseUrl);
        if (!vapid.enabled) {
          toastManager.add({
            type: "warning",
            title: t("Server Web Push is disabled"),
            description: t("Turn on Server Web Push before enabling this device."),
          });
          setBusy(null);
          return;
        }
        const subscription = await subscribeBrowserToWebPush(vapid.publicKey);
        const registered = await registerBrowserPushSubscription(baseUrl, subscription, {
          environmentId,
          label: t("This browser"),
        });
        setCurrentId(registered.id);
        setBrowserSubscription(subscription);
        setSubscriptions((current) => [
          ...current.filter((entry) => entry.id !== registered.id),
          registered,
        ]);
        toastManager.add({ type: "success", title: t("Push enabled on this device") });
      } else {
        if (!currentRegistration) {
          setBusy(null);
          return;
        }
        const result = await deletePushSubscription(baseUrl, currentRegistration.id);
        if (!result.deleted) {
          setSubscriptions(await fetchPushSubscriptions(baseUrl));
          toastManager.add({ type: "warning", title: t("Push subscription was not deleted") });
          setBusy(null);
          return;
        }
        await unsubscribeBrowserFromWebPush();
        setBrowserSubscription(null);
        setCurrentId(null);
        setSubscriptions((current) =>
          current.filter((entry) => entry.id !== currentRegistration?.id),
        );
        toastManager.add({ type: "success", title: t("Push disabled on this device") });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Could not change this device's Web Push setting"),
        description: errorMessage(error, t("Try the Web Push request again.")),
      });
    }
    setBusy(null);
  };

  const remove = async (subscription: RegisteredPushSubscription) => {
    if (busy) return;
    setBusy(subscription.id);
    try {
      const result = await deletePushSubscription(baseUrl, subscription.id);
      if (!result.deleted) {
        setSubscriptions(await fetchPushSubscriptions(baseUrl));
        toastManager.add({ type: "warning", title: t("Push subscription was not deleted") });
        setBusy(null);
        return;
      }
      if (subscription.id === currentRegistration?.id) {
        await unsubscribeBrowserFromWebPush();
        setBrowserSubscription(null);
        setCurrentId(null);
      }
      setSubscriptions((current) => current.filter((entry) => entry.id !== subscription.id));
      toastManager.add({ type: "success", title: t("Push subscription deleted") });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Push subscription was not deleted"),
        description: errorMessage(error, t("Try deleting the subscription again.")),
      });
    }
    setBusy(null);
  };

  const sendTest = async () => {
    if (!currentRegistration || busy) return;
    setBusy("test");
    try {
      const result = await sendTestNotification(baseUrl, {
        target: "web_push",
        subscriptionId: currentRegistration.id,
      });
      toastManager.add({
        type: result.delivered ? "success" : "error",
        title: result.delivered ? t("Test push sent") : t("Test push was not delivered"),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Test push was not delivered"),
        description: errorMessage(error, t("Try the test push again.")),
      });
    }
    setBusy(null);
  };

  return (
    <SettingsSection id="web-push" title={t("Web Push")}>
      <SettingsRow
        title={t("Server Web Push")}
        description={t("Allow this Cox server to deliver notifications to registered browsers.")}
        control={
          <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
            <Switch
              aria-label={t("Server Web Push")}
              checked={enabled}
              disabled={readOnly || busy !== null}
              onCheckedChange={(checked) => void onSave(checked)}
            />
          </label>
        }
      />
      <WebPushSupportNotice support={support} />
      <SettingsRow
        title={t("Enable Push on this device")}
        description={t("Subscribe this browser and register it with the connected Cox server.")}
        control={
          <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
            <Switch
              aria-label={t("Enable Push on this device")}
              checked={browserSubscription !== null}
              disabled={
                readOnly ||
                loading ||
                busy !== null ||
                !support.supported ||
                (browserSubscription !== null && !currentRegistration)
              }
              onCheckedChange={(checked) => void changeDevice(checked)}
            />
          </label>
        }
      />
      <WebPushSubscriptionsRow
        subscriptions={subscriptions}
        loading={loading}
        loadFailed={loadFailed}
        readOnly={readOnly}
        busy={busy !== null}
        onRemove={(subscription) => void remove(subscription)}
      />
      <SettingsRow
        title={t("Test this device")}
        description={t("Send a test notification to this browser's registered subscription.")}
        control={
          <Button
            size="touch"
            variant="outline"
            disabled={readOnly || !currentRegistration || busy !== null}
            onClick={() => void sendTest()}
          >
            {t("Send Test Push")}
          </Button>
        }
      />
    </SettingsSection>
  );
}
