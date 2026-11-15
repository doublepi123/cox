import { MAX_NOTIFICATION_WEBHOOKS, type NotificationWebhookChannel } from "@t3tools/contracts";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import {
  NOTIFICATION_PROVIDER_LABELS,
  NotificationWebhookEditor,
} from "./NotificationWebhookEditor";
import { sendTestNotification } from "./notificationsApi";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface WebhookSettingsSectionProps {
  readonly baseUrl: string;
  readonly channels: readonly NotificationWebhookChannel[];
  readonly readOnly: boolean;
  readonly onSave: (channels: readonly NotificationWebhookChannel[]) => Promise<boolean>;
}

export function WebhookSettingsSection({
  baseUrl,
  channels,
  readOnly,
  onSave,
}: WebhookSettingsSectionProps) {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const persist = async (next: readonly NotificationWebhookChannel[]) => {
    setBusy("save");
    const saved = await onSave(next);
    setBusy(null);
    return saved;
  };
  const saveEditor = async (channel: NotificationWebhookChannel) => {
    const exists = channels.some((candidate) => candidate.id === channel.id);
    const next = exists
      ? channels.map((candidate) => (candidate.id === channel.id ? channel : candidate))
      : [...channels, channel];
    const saved = await persist(next);
    if (saved) setEditingId(null);
    return saved;
  };
  const remove = async (channel: NotificationWebhookChannel) => {
    const saved = await persist(channels.filter((candidate) => candidate.id !== channel.id));
    if (saved) {
      if (editingId === channel.id) setEditingId(null);
      toastManager.add({ type: "success", title: t("Webhook channel deleted") });
    }
  };
  const sendTest = async (channel: NotificationWebhookChannel) => {
    setBusy(channel.id);
    try {
      const result = await sendTestNotification(baseUrl, {
        target: "webhook",
        channelId: channel.id,
      });
      toastManager.add({
        type: result.delivered ? "success" : "error",
        title: result.delivered ? t("Test Webhook sent") : t("Test Webhook was not delivered"),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("Test Webhook was not delivered"),
        description: error instanceof Error ? error.message : t("Try the test Webhook again."),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SettingsSection
      id="notification-webhooks"
      title={t("Outbound Webhooks")}
      headerAction={
        <Button
          size="touch"
          disabled={readOnly || busy !== null || channels.length >= MAX_NOTIFICATION_WEBHOOKS}
          onClick={() => setEditingId("new")}
        >
          <PlusIcon />
          {t("Add Webhook")}
        </Button>
      }
    >
      <p className="px-3 py-3 text-sm leading-relaxed text-muted-foreground sm:px-4">
        {t(
          "Send Bark, Telegram, Ntfy, or generic JSON notifications without browser Web Push. Configure up to 10 channels.",
        )}
      </p>
      {channels.length === 0 && editingId !== "new" ? (
        <SettingsRow
          title={t("No Webhooks configured.")}
          description={t(
            "Add a Bark, Telegram, Ntfy, or Generic JSON channel to receive notifications.",
          )}
        />
      ) : null}
      {channels.map((channel) =>
        editingId === channel.id ? (
          <SettingsRow key={channel.id} title={t("Edit {label}", { label: channel.label })}>
            <div className="py-3">
              <NotificationWebhookEditor
                channel={channel}
                disabled={readOnly || busy !== null}
                onSave={saveEditor}
                onCancel={() => setEditingId(null)}
              />
            </div>
          </SettingsRow>
        ) : (
          <SettingsRow
            key={channel.id}
            title={channel.label}
            description={t(NOTIFICATION_PROVIDER_LABELS[channel.provider])}
            control={
              <label className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                <Switch
                  aria-label={t("Enable {label}", { label: channel.label })}
                  checked={channel.enabled}
                  disabled={readOnly || busy !== null}
                  onCheckedChange={(checked) =>
                    void persist(
                      channels.map((candidate) =>
                        candidate.id === channel.id
                          ? { ...candidate, enabled: checked }
                          : candidate,
                      ),
                    )
                  }
                />
              </label>
            }
          >
            <div className="flex flex-wrap gap-2 py-3">
              <Button
                size="touch"
                variant="outline"
                disabled={readOnly || busy !== null}
                onClick={() => setEditingId(channel.id)}
              >
                <PencilIcon />
                {t("Edit")}
              </Button>
              <Button
                size="touch"
                variant="outline"
                disabled={readOnly || busy !== null}
                onClick={() => void sendTest(channel)}
              >
                {t("Send Test")}
              </Button>
              <Button
                size="touch"
                variant="ghost-destructive"
                disabled={readOnly || busy !== null}
                onClick={() => void remove(channel)}
              >
                <Trash2Icon />
                {t("Delete")}
              </Button>
            </div>
          </SettingsRow>
        ),
      )}
      {editingId === "new" ? (
        <SettingsRow title={t("Add Webhook channel")}>
          <div className="py-3">
            <NotificationWebhookEditor
              disabled={readOnly || busy !== null}
              onSave={saveEditor}
              onCancel={() => setEditingId(null)}
            />
          </div>
        </SettingsRow>
      ) : null}
    </SettingsSection>
  );
}
