import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { WebPushService } from "./WebPushService.ts";
import { notificationBaseOrigin } from "./notificationLinks.ts";
import {
  resolveWebhookChannelSecret,
  WebhookNotificationError,
  WebhookNotificationService,
  type WebhookNotificationMessage,
} from "./WebhookNotificationService.ts";

const encodeMessage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export const makeAgentNotificationDelivery = Effect.gen(function* () {
  const subscriptions = yield* NotificationSubscriptionRepository;
  const settings = yield* ServerSettingsService;
  const push = yield* WebPushService;
  const config = yield* ServerConfig;
  const webhook = new WebhookNotificationService({ ownServerPort: config.port });
  const secretStore = yield* ServerSecretStore;
  const secretResolver = yield* SecretResolver;
  return Effect.fnUntraced(function* (message: WebhookNotificationMessage) {
    const notificationSettings = (yield* settings.getSettings).notifications;
    const notification = {
      ...message,
      deepLinkUrl: new URL(
        message.threadPath,
        notificationBaseOrigin(notificationSettings.publicBaseUrl, config),
      ).toString(),
    };
    const pushDelivery = Effect.gen(function* () {
      if (!notificationSettings.webPushEnabled) return;
      const targets = yield* subscriptions.listDeliverableSubscriptions({ now: message.timestamp });
      const payload = new TextEncoder().encode(yield* encodeMessage(notification));
      yield* Effect.forEach(
        targets,
        (target) =>
          Effect.gen(function* () {
            const result = yield* push.send(target, payload);
            switch (result.status) {
              case "delivered":
                return yield* subscriptions.markSubscriptionDelivered({
                  id: target.id,
                  deliveredAt: message.timestamp,
                });
              case "gone":
                return yield* subscriptions.markSubscriptionGone({ id: target.id });
              case "failed":
                return yield* Effect.logWarning("Agent push notification failed", {
                  reason: result.error.reason,
                });
              default: {
                const exhaustive: never = result;
                return exhaustive;
              }
            }
          }).pipe(Effect.catch(() => Effect.logWarning("Agent push subscription update failed"))),
        { concurrency: 8, discard: true },
      );
    }).pipe(Effect.catch(() => Effect.logWarning("Agent push notification dispatch failed")));
    const webhookDelivery = Effect.forEach(
      notificationSettings.webhooks.filter(
        (channel) => channel.enabled && channel.events.includes(message.kind),
      ),
      (channel) =>
        Effect.gen(function* () {
          const secret = yield* resolveWebhookChannelSecret(channel).pipe(
            Effect.provideService(ServerSecretStore, secretStore),
            Effect.provideService(SecretResolver, secretResolver),
          );
          yield* Effect.tryPromise({
            try: () => webhook.deliver(channel, notification, secret),
            catch: (error) =>
              error instanceof WebhookNotificationError
                ? error
                : new WebhookNotificationError("transport_failed"),
          });
        }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Agent webhook notification failed", { channelId: channel.id }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
    yield* Effect.all([pushDelivery, webhookDelivery], { concurrency: "unbounded" });
  });
});
