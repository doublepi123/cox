import type { RegisteredPushSubscription } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";

import { useTranslation } from "../../i18n";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

interface WebPushSubscriptionsRowProps {
  readonly subscriptions: readonly RegisteredPushSubscription[];
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly readOnly: boolean;
  readonly busy: boolean;
  readonly onRemove: (subscription: RegisteredPushSubscription) => void;
}

export function WebPushSubscriptionsRow({
  subscriptions,
  loading,
  loadFailed,
  readOnly,
  busy,
  onRemove,
}: WebPushSubscriptionsRowProps) {
  const { t } = useTranslation();
  return (
    <SettingsRow
      title={t("Push subscriptions")}
      description={
        loadFailed
          ? t("Could not load push subscriptions.")
          : loading
            ? t("Loading push subscriptions…")
            : subscriptions.length === 0
              ? t("No push subscriptions registered.")
              : t("{count} registered devices", { count: subscriptions.length })
      }
    >
      {subscriptions.length > 0 ? (
        <ul className="divide-y divide-border/60 pt-2">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className="flex min-w-0 items-center gap-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{subscription.label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {subscription.endpointOrigin}
                </p>
              </div>
              <Button
                size="touch"
                variant="ghost-destructive"
                aria-label={t("Delete push subscription {label}", { label: subscription.label })}
                disabled={readOnly || busy}
                onClick={() => onRemove(subscription)}
              >
                <Trash2Icon />
                {t("Delete")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}
