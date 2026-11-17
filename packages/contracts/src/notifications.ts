import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AuthSessionId, IsoDateTime, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { SettingsSecretValue } from "./settingsSecretValue.ts";
import { NotificationPublicBaseUrl } from "./notificationPublicBaseUrl.ts";

export { NotificationPublicBaseUrl } from "./notificationPublicBaseUrl.ts";

export const NotificationEventKind = Schema.Literals([
  "turn_completed",
  "turn_failed",
  "human_attention",
]);
export type NotificationEventKind = typeof NotificationEventKind.Type;

export const NotificationWebhookProvider = Schema.Literals(["bark", "telegram", "ntfy", "json"]);
export type NotificationWebhookProvider = typeof NotificationWebhookProvider.Type;

const P256_FIELD_PRIME = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const P256_CURVE_B = 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*={0,2}$/;

const decodeBase64Url = (value: string): Uint8Array | undefined => {
  if (!BASE64URL_PATTERN.test(value)) return undefined;
  const unpadded = value.replace(/=+$/, "");
  const padding = value.length - unpadded.length;
  if (
    value.length % 4 === 1 ||
    (padding > 0 && value.length % 4 !== 0) ||
    (padding === 1 && unpadded.length % 4 !== 3) ||
    (padding === 2 && unpadded.length % 4 !== 2)
  ) {
    return undefined;
  }
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  const canonical = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return canonical === unpadded ? bytes : undefined;
};

const readBigEndian = (bytes: Uint8Array): bigint => {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
};

const isP256PublicKey = (value: string): boolean => {
  const bytes = decodeBase64Url(value);
  if (bytes === undefined || bytes.length !== 65 || bytes[0] !== 0x04) return false;

  const x = readBigEndian(bytes.slice(1, 33));
  const y = readBigEndian(bytes.slice(33, 65));
  if (x >= P256_FIELD_PRIME || y >= P256_FIELD_PRIME) return false;

  const left = (y * y) % P256_FIELD_PRIME;
  const right =
    (((((x * x) % P256_FIELD_PRIME) * x) % P256_FIELD_PRIME) +
      (((P256_FIELD_PRIME - 3n) * x) % P256_FIELD_PRIME) +
      P256_CURVE_B) %
    P256_FIELD_PRIME;
  return left === right;
};

export const PushSubscriptionP256dhKey = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      isP256PublicKey(value) ||
      "p256dh must be the base64url encoding of a 65-byte P-256 public key.",
  ),
);
export type PushSubscriptionP256dhKey = typeof PushSubscriptionP256dhKey.Type;

export const PushSubscriptionAuthKey = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    const bytes = decodeBase64Url(value);
    return (
      (bytes !== undefined && bytes.length >= 16 && bytes.length <= 192) ||
      "auth must decode to 16 to 192 base64url bytes."
    );
  }),
);
export type PushSubscriptionAuthKey = typeof PushSubscriptionAuthKey.Type;

export const PushSubscriptionKeys = Schema.Struct({
  p256dh: PushSubscriptionP256dhKey,
  auth: PushSubscriptionAuthKey,
});
export type PushSubscriptionKeys = typeof PushSubscriptionKeys.Type;

const PushEndpointUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        ((url.protocol === "https:" || url.protocol === "http:") &&
          !url.username &&
          !url.password) ||
        "Push endpoint must be an HTTP(S) URL without credentials."
      );
    } catch {
      return "Push endpoint must be an HTTP(S) URL without credentials.";
    }
  }),
);

export const NOTIFICATION_LABEL_MAX_LENGTH = 120;
export const NotificationLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(NOTIFICATION_LABEL_MAX_LENGTH),
);

export const PushSubscriptionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("PushSubscriptionId"),
);
export type PushSubscriptionId = typeof PushSubscriptionId.Type;

export const MobilePushSubscriptionInput = Schema.Struct({
  endpoint: PushEndpointUrl,
  keys: PushSubscriptionKeys,
  userAgent: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(512))),
  label: NotificationLabel,
});
export type MobilePushSubscriptionInput = typeof MobilePushSubscriptionInput.Type;

export const RegisteredPushSubscription = Schema.Struct({
  id: PushSubscriptionId,
  sessionId: AuthSessionId,
  endpointOrigin: TrimmedNonEmptyString,
  label: NotificationLabel,
  createdAt: IsoDateTime,
  lastDeliveredAt: Schema.NullOr(IsoDateTime),
});
export type RegisteredPushSubscription = typeof RegisteredPushSubscription.Type;

export const VapidPublicKey = TrimmedNonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      isP256PublicKey(value) ||
      "VAPID public key must be the base64url encoding of a 65-byte P-256 public key.",
  ),
);

export const VapidPublicKeyResponse = Schema.Struct({
  publicKey: VapidPublicKey,
  enabled: Schema.Boolean,
});
export type VapidPublicKeyResponse = typeof VapidPublicKeyResponse.Type;

export const PushSubscriptionsListResponse = Schema.Struct({
  subscriptions: Schema.Array(RegisteredPushSubscription),
});
export type PushSubscriptionsListResponse = typeof PushSubscriptionsListResponse.Type;

export const DeletePushSubscriptionResponse = Schema.Struct({ deleted: Schema.Boolean });
export type DeletePushSubscriptionResponse = typeof DeletePushSubscriptionResponse.Type;

export const NotificationWebhookChannelId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
).pipe(Schema.brand("NotificationWebhookChannelId"));
export type NotificationWebhookChannelId = typeof NotificationWebhookChannelId.Type;

export const NOTIFICATION_WEBHOOK_URL_MAX_LENGTH = 2048;
export const MAX_NOTIFICATION_WEBHOOKS = 10;

const webhookUrlIssue = (url: string, allowPrivateNetwork: boolean): string | true => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "Webhook URL must be a valid HTTP(S) URL.";
  }
  if (parsed.username || parsed.password) return "Webhook URL must not contain credentials.";
  if (parsed.protocol === "https:") return true;
  if (parsed.protocol === "http:") {
    return (
      allowPrivateNetwork ||
      "Webhook URL must use HTTPS, or allow private network access for plain HTTP."
    );
  }
  return "Webhook URL must be a valid HTTP(S) URL.";
};

export const NotificationWebhookChannel = Schema.Struct({
  id: NotificationWebhookChannelId,
  label: NotificationLabel,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  provider: NotificationWebhookProvider,
  url: TrimmedNonEmptyString.check(Schema.isMaxLength(NOTIFICATION_WEBHOOK_URL_MAX_LENGTH)),
  secret: SettingsSecretValue.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  chatId: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  allowPrivateNetwork: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  events: Schema.Array(NotificationEventKind),
}).check(Schema.makeFilter((channel) => webhookUrlIssue(channel.url, channel.allowPrivateNetwork)));
export type NotificationWebhookChannel = typeof NotificationWebhookChannel.Type;

export const MobileNotificationSettings = Schema.Struct({
  publicBaseUrl: Schema.NullOr(NotificationPublicBaseUrl).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  webPushEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  webhooks: Schema.Array(NotificationWebhookChannel)
    .check(Schema.isMaxLength(MAX_NOTIFICATION_WEBHOOKS))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type MobileNotificationSettings = typeof MobileNotificationSettings.Type;

// Webhooks patch as whole lists of full entries so a merged settings file always
// re-decodes through NotificationWebhookChannel, including its URL policy.
export const MobileNotificationSettingsPatch = Schema.Struct({
  publicBaseUrl: Schema.optionalKey(Schema.NullOr(NotificationPublicBaseUrl)),
  webPushEnabled: Schema.optionalKey(Schema.Boolean),
  webhooks: Schema.optionalKey(
    Schema.Array(NotificationWebhookChannel).check(Schema.isMaxLength(MAX_NOTIFICATION_WEBHOOKS)),
  ),
});
export type MobileNotificationSettingsPatch = typeof MobileNotificationSettingsPatch.Type;

export const TestNotificationRequest = Schema.Union([
  Schema.Struct({
    target: Schema.Literal("web_push"),
    subscriptionId: Schema.optionalKey(PushSubscriptionId),
  }),
  Schema.Struct({
    target: Schema.Literal("webhook"),
    channelId: NotificationWebhookChannelId,
  }),
]);
export type TestNotificationRequest = typeof TestNotificationRequest.Type;

export const TestNotificationResponse = Schema.Struct({ delivered: Schema.Boolean });
export type TestNotificationResponse = typeof TestNotificationResponse.Type;

export const NOTIFICATION_VAPID_PUBLIC_KEY_PATH = "/api/notifications/vapid-public-key";
export const NOTIFICATION_PUSH_SUBSCRIPTIONS_PATH = "/api/notifications/push-subscriptions";
export const NOTIFICATION_PUSH_SUBSCRIPTION_PATH = "/api/notifications/push-subscriptions/:id";
export const NOTIFICATION_TEST_PATH = "/api/notifications/test";
