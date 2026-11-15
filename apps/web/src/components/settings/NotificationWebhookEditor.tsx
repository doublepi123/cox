import {
  NotificationWebhookChannel,
  NotificationWebhookChannelId,
  NotificationWebhookProvider,
  type NotificationEventKind,
  type NotificationWebhookChannel as NotificationWebhookChannelValue,
  type NotificationWebhookProvider as NotificationWebhookProviderValue,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretInput } from "./SecretInput";

const PROVIDERS = ["bark", "telegram", "ntfy", "json"] as const;
export const NOTIFICATION_PROVIDER_LABELS: Record<NotificationWebhookProviderValue, string> = {
  bark: "Bark",
  telegram: "Telegram",
  ntfy: "Ntfy",
  json: "Generic JSON",
};
const URL_LABELS: Record<NotificationWebhookProviderValue, string> = {
  bark: "Bark server URL with device key",
  telegram: "Telegram Bot API sendMessage URL",
  ntfy: "Ntfy topic URL",
  json: "Generic JSON endpoint URL",
};
const EVENT_LABELS: Record<NotificationEventKind, string> = {
  human_attention: "Needs human attention",
  turn_completed: "Turn completed",
  turn_failed: "Turn failed",
};
const EVENTS = ["human_attention", "turn_completed", "turn_failed"] as const;
const decodeChannel = Schema.decodeSync(NotificationWebhookChannel);
const isWebhookProvider = Schema.is(NotificationWebhookProvider);

interface WebhookDraft {
  readonly provider: NotificationWebhookProviderValue;
  readonly label: string;
  readonly url: string;
  readonly secret: string;
  readonly chatId: string;
  readonly allowPrivateNetwork: boolean;
  readonly events: readonly NotificationEventKind[];
}

interface NotificationWebhookEditorProps {
  readonly channel?: NotificationWebhookChannelValue;
  readonly disabled: boolean;
  readonly onSave: (channel: NotificationWebhookChannelValue) => Promise<boolean>;
  readonly onCancel: () => void;
}

export function NotificationWebhookEditor({
  channel,
  disabled,
  onSave,
  onCancel,
}: NotificationWebhookEditorProps) {
  const { t } = useTranslation();
  const [newId] = useState(() => NotificationWebhookChannelId.make(`webhook_${randomUUID()}`));
  const [draft, setDraft] = useState<WebhookDraft>(() => ({
    provider: channel?.provider ?? "bark",
    label: channel?.label ?? "",
    url: channel?.url ?? "",
    secret: "",
    chatId: channel?.chatId ?? "",
    allowPrivateNetwork: channel?.allowPrivateNetwork ?? false,
    events: channel?.events ?? ["human_attention", "turn_failed"],
  }));
  const [error, setError] = useState(false);
  const update = <Key extends keyof WebhookDraft>(key: Key, value: WebhookDraft[Key]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setError(false);
  };
  const save = async () => {
    try {
      const parsed = decodeChannel({
        id: channel?.id ?? newId,
        enabled: channel?.enabled ?? true,
        provider: draft.provider,
        label: draft.label,
        url: draft.url,
        secret: draft.secret.trim() || channel?.secret || "",
        ...(draft.provider === "telegram" ? { chatId: draft.chatId } : {}),
        allowPrivateNetwork: draft.allowPrivateNetwork,
        events: draft.events,
      });
      if (!(await onSave(parsed))) setError(true);
    } catch {
      setError(true);
    }
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid min-w-0 gap-2 text-sm font-medium">
          {t("Provider")}
          <Select
            value={draft.provider}
            disabled={disabled}
            onValueChange={(value) => {
              if (isWebhookProvider(value)) update("provider", value);
            }}
          >
            <SelectTrigger fill size="default" aria-label={t("Provider")}>
              <SelectValue>{t(NOTIFICATION_PROVIDER_LABELS[draft.provider])}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {PROVIDERS.map((provider) => (
                <SelectItem key={provider} value={provider}>
                  {t(NOTIFICATION_PROVIDER_LABELS[provider])}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
        <label className="grid min-w-0 gap-2 text-sm font-medium">
          {t("Channel name")}
          <Input
            size="touch"
            value={draft.label}
            disabled={disabled}
            onChange={(event) => update("label", event.currentTarget.value)}
            placeholder={t("My phone")}
            required
          />
        </label>
      </div>
      <label className="grid min-w-0 gap-2 text-sm font-medium">
        {t(URL_LABELS[draft.provider])}
        <Input
          size="touch"
          type="url"
          value={draft.url}
          disabled={disabled}
          onChange={(event) => update("url", event.currentTarget.value)}
          placeholder="https://example.com/hook"
          required
        />
      </label>
      {draft.provider === "telegram" ? (
        <label className="grid min-w-0 gap-2 text-sm font-medium">
          {t("Telegram chat ID")}
          <Input
            size="touch"
            value={draft.chatId}
            disabled={disabled}
            onChange={(event) => update("chatId", event.currentTarget.value)}
            placeholder="-1001234567890"
            required
          />
        </label>
      ) : null}
      <label className="grid min-w-0 gap-2 text-sm font-medium">
        {t("Secret or access token")}
        <SecretInput
          size="touch"
          configured={Boolean(channel?.secret)}
          value={draft.secret}
          disabled={disabled}
          onChange={(event) => update("secret", event.currentTarget.value)}
          placeholder={t("Optional for unauthenticated Webhooks")}
        />
      </label>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-medium">{t("Notification events")}</legend>
        <div className="grid gap-1 sm:grid-cols-3">
          {EVENTS.map((kind) => {
            const label = EVENT_LABELS[kind];
            return (
              <label
                key={kind}
                className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm"
              >
                <Checkbox
                  checked={draft.events.includes(kind)}
                  onCheckedChange={(checked) =>
                    update(
                      "events",
                      checked === true
                        ? [...draft.events, kind]
                        : draft.events.filter((candidate) => candidate !== kind),
                    )
                  }
                />
                {t(label)}
              </label>
            );
          })}
        </div>
      </fieldset>
      <div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm font-medium">
          <Checkbox
            checked={draft.allowPrivateNetwork}
            disabled={disabled}
            onCheckedChange={(checked) => update("allowPrivateNetwork", checked === true)}
          />
          {t("Allow private network HTTP")}
        </label>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("Permits a plain http:// Webhook URL on your LAN. Public endpoints should use HTTPS.")}
        </p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(
            "Check the channel name, URL, Telegram chat ID, and private network option, then save again.",
          )}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="touch" variant="outline" disabled={disabled} onClick={onCancel}>
          {t("Cancel")}
        </Button>
        <Button size="touch" type="submit" disabled={disabled}>
          {channel ? t("Save channel") : t("Add channel")}
        </Button>
      </div>
    </form>
  );
}
