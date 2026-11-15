import type { WebPushSupportState } from "../../pwa/serviceWorkerRegistration";
import { useTranslation } from "../../i18n";

const SUPPORT_MESSAGES: Record<
  Extract<WebPushSupportState, { supported: false }>["reason"],
  string
> = {
  insecure_context:
    "Browser Web Push requires HTTPS, such as Tailscale HTTPS or a reverse proxy. Bark, Telegram, Ntfy, and JSON Webhooks below also work over plain HTTP LAN connections.",
  ios_requires_standalone_pwa:
    "Add Cox to your Home Screen first to use Web Push in iOS Safari, or use a Bark, Telegram, Ntfy, or JSON Webhook below.",
  service_worker_unavailable:
    "This browser does not support the service worker required for Web Push. You can still use the Webhook channels below.",
  push_unavailable:
    "This browser does not support Web Push. You can still use the Webhook channels below.",
  notification_permission_denied:
    "Notifications are blocked for this site. Allow them in browser settings, or use a Webhook channel below.",
};

export function WebPushSupportNotice({ support }: { readonly support: WebPushSupportState }) {
  const { t } = useTranslation();
  if (support.supported) return null;
  return (
    <p
      role="note"
      className="bg-muted/30 px-3 py-3 text-sm leading-relaxed text-muted-foreground sm:px-4"
    >
      {t(SUPPORT_MESSAGES[support.reason])}
    </p>
  );
}
