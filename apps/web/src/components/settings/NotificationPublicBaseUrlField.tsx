import { NotificationPublicBaseUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow } from "./settingsLayout";

const isPublicBaseUrl = Schema.is(NotificationPublicBaseUrl);

export const parseNotificationPublicBaseUrl = (value: string): string | null | undefined => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return isPublicBaseUrl(trimmed) ? new URL(trimmed).origin : undefined;
};

export function NotificationPublicBaseUrlField({
  value,
  onChange,
  disabled,
  onSave,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled: boolean;
  readonly onSave: (publicBaseUrl: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const origin = parseNotificationPublicBaseUrl(value);
    setInvalid(origin === undefined);
    if (origin === undefined) return;
    setSaving(true);
    await onSave(origin);
    setSaving(false);
  };
  return (
    <SettingsRow
      title={t("Server URL for notification links")}
      description={t("Use the HTTP(S) origin that opens this Cox server from your phone.")}
    >
      <div className="flex flex-wrap gap-2 py-3">
        <div className="min-w-0 flex-1">
          <Input
            aria-label={t("Server URL for notification links")}
            aria-invalid={invalid}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
              setInvalid(false);
            }}
            disabled={disabled || saving}
            placeholder="https://cox.example.com"
          />
        </div>
        <Button size="touch" disabled={disabled || saving} onClick={() => void save()}>
          {t("Save server URL")}
        </Button>
        {invalid ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {t("Enter an HTTP(S) origin without a path, credentials, query, or fragment.")}
          </p>
        ) : null}
      </div>
    </SettingsRow>
  );
}
