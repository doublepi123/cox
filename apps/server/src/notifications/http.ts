import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  EnvironmentNotificationTestRateLimitedError,
  EnvironmentRequestInvalidError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import {
  annotateEnvironmentRequest,
  currentEnvironmentTraceId,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import type { StoredMobilePushSubscription } from "../persistence/NotificationSubscriptions.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  resolveWebhookChannelSecret,
  WebhookNotificationError,
  type WebhookNotificationMessage,
  WebhookNotificationService,
} from "./WebhookNotificationService.ts";
import { WebPushService } from "./WebPushService.ts";

const TEST_NOTIFICATION_LIMIT = 5;
const TEST_NOTIFICATION_WINDOW_MS = 60_000;
const TEST_PUSH_TITLE = "Cox test notification";
const TEST_PUSH_BODY = "If you can read this, web push delivery works.";
const TEST_WEBHOOK_BODY = "If you can read this, webhook delivery works.";

const TestPushPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  tag: Schema.String,
});
const encodeTestPushPayload = Schema.encodeSync(Schema.fromJsonString(TestPushPayload));
const nowIso = (millis: number): string => DateTime.formatIso(DateTime.makeUnsafe(millis));

const toRegisteredSubscription = (stored: StoredMobilePushSubscription) => ({
  id: stored.id,
  sessionId: stored.sessionId,
  endpointOrigin: stored.endpointOrigin,
  label: stored.label,
  createdAt: stored.createdAt,
  lastDeliveredAt: stored.lastDeliveredAt,
});

const ownServerPort = (request: HttpServerRequest.HttpServerRequest): number => {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) return 443;
  if (url.value.port !== "") return Number(url.value.port);
  return url.value.protocol === "https:" ? 443 : 80;
};
export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "notifications",
  Effect.fnUntraced(function* (handlers) {
    const webPush = yield* WebPushService;
    const subscriptions = yield* NotificationSubscriptionRepository;
    const settingsService = yield* ServerSettings.ServerSettingsService;

    const readSettings = settingsService.getSettings.pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        failEnvironmentInternal("internal_error", cause),
      ),
    );
    const catchRepositoryError = (cause: unknown) =>
      failEnvironmentInternal("internal_error", cause);

    const attemptLog = yield* Ref.make(new Map<string, ReadonlyArray<number>>());
    const consumeTestQuota = Effect.fn("environment.notifications.consumeTestQuota")(function* (
      sessionId: string,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const cutoff = now - TEST_NOTIFICATION_WINDOW_MS;
      const retained = new Map<string, ReadonlyArray<number>>();
      let sessionAttempts: ReadonlyArray<number> = [];
      for (const [key, timestamps] of yield* Ref.get(attemptLog)) {
        const fresh = timestamps.filter((timestamp) => timestamp > cutoff);
        if (key === sessionId) sessionAttempts = fresh;
        else if (fresh.length > 0) retained.set(key, fresh);
      }
      if (sessionAttempts.length >= TEST_NOTIFICATION_LIMIT) {
        const retryAfterSeconds = Math.max(
          1,
          Math.min(
            ...sessionAttempts.map((timestamp) =>
              Math.ceil((timestamp + TEST_NOTIFICATION_WINDOW_MS - now) / 1000),
            ),
          ),
        );
        const traceId = yield* currentEnvironmentTraceId;
        return yield* new EnvironmentNotificationTestRateLimitedError({
          code: "test_rate_limited",
          retryAfterSeconds,
          traceId,
        });
      }
      yield* Ref.set(attemptLog, retained.set(sessionId, [...sessionAttempts, now]));
    });

    return handlers
      .handle(
        "vapidPublicKey",
        Effect.fn("environment.notifications.vapidPublicKey")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const settings = yield* readSettings;
          const publicKey = yield* webPush.getVapidPublicKey.pipe(
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          return { publicKey, enabled: settings.notifications.webPushEnabled };
        }),
      )
      .handle(
        "pushSubscriptions",
        Effect.fn("environment.notifications.pushSubscriptions")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const stored = yield* subscriptions
            .listSubscriptionsForSession({ sessionId: principal.sessionId })
            .pipe(Effect.catch(catchRepositoryError));
          return { subscriptions: stored.map(toRegisteredSubscription) };
        }),
      )
      .handle(
        "pushSubscriptionCreate",
        Effect.fn("environment.notifications.pushSubscriptionCreate")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (!(yield* webPush.validateEndpoint(args.payload.endpoint))) {
            return yield* failEnvironmentInvalidRequest("invalid_command");
          }
          const stored = yield* subscriptions
            .upsertSubscription({
              sessionId: principal.sessionId,
              endpoint: args.payload.endpoint,
              endpointOrigin: new URL(args.payload.endpoint).origin,
              keys: args.payload.keys,
              label: args.payload.label,
              userAgent: args.payload.userAgent ?? null,
              createdAt: nowIso(yield* Clock.currentTimeMillis),
            })
            .pipe(Effect.catch(catchRepositoryError));
          return toRegisteredSubscription(stored);
        }),
      )
      .handle(
        "pushSubscriptionDelete",
        Effect.fn("environment.notifications.pushSubscriptionDelete")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const deleted = yield* subscriptions
            .deleteSubscriptionForSession({ id: args.params.id, sessionId: principal.sessionId })
            .pipe(Effect.catch(catchRepositoryError));
          if (!deleted) return yield* failEnvironmentNotFound("push_subscription_not_found");
          return { deleted: true };
        }),
      )
      .handle(
        "test",
        Effect.fn("environment.notifications.test")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const principal = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          yield* consumeTestQuota(principal.sessionId);
          const nowMillis = yield* Clock.currentTimeMillis;
          const payload = args.payload;

          if (payload.target === "web_push") {
            const sessionSubscriptions = yield* subscriptions
              .listSubscriptionsForSession({ sessionId: principal.sessionId })
              .pipe(Effect.catch(catchRepositoryError));
            const targets =
              payload.subscriptionId === undefined
                ? sessionSubscriptions
                : sessionSubscriptions.filter(
                    (subscription) => subscription.id === payload.subscriptionId,
                  );
            if (targets.length === 0)
              return yield* failEnvironmentInvalidRequest("invalid_command");
            const pushPayload = new TextEncoder().encode(
              encodeTestPushPayload({
                title: TEST_PUSH_TITLE,
                body: TEST_PUSH_BODY,
                tag: "cox-test",
              }),
            );
            let delivered = false;
            for (const target of targets) {
              const result = yield* webPush.send(target, pushPayload);
              if (result.status === "delivered") delivered = true;
              else if (result.status === "gone") {
                yield* subscriptions
                  .markSubscriptionGone({ id: target.id })
                  .pipe(Effect.catch(catchRepositoryError));
              }
            }
            return { delivered };
          }

          const settings = yield* readSettings;
          const channel = settings.notifications.webhooks.find(
            (candidate) => candidate.id === payload.channelId,
          );
          if (channel === undefined) return yield* failEnvironmentInvalidRequest("invalid_command");
          const secret = yield* resolveWebhookChannelSecret(channel).pipe(
            Effect.catch(
              (
                error,
              ): Effect.Effect<never, EnvironmentRequestInvalidError | EnvironmentInternalError> =>
                error instanceof WebhookNotificationError
                  ? failEnvironmentInvalidRequest("invalid_command")
                  : failEnvironmentInternal("internal_error", error),
            ),
          );
          const request = yield* HttpServerRequest.HttpServerRequest;
          const origin = HttpServerRequest.toURL(request);
          const message: WebhookNotificationMessage = {
            event: "notifications.test",
            kind: "human_attention",
            threadId: ThreadId.make("test"),
            threadPath: "/settings/notifications",
            ...(Option.isSome(origin)
              ? { deepLinkUrl: `${origin.value.origin}/settings/notifications` }
              : {}),
            title: TEST_PUSH_TITLE,
            body: TEST_WEBHOOK_BODY,
            timestamp: nowIso(nowMillis),
          };
          const dispatcher = new WebhookNotificationService({
            ownServerPort: ownServerPort(request),
          });
          const delivery = yield* Effect.result(
            Effect.tryPromise({
              try: () => dispatcher.deliver(channel, message, secret),
              catch: (error): WebhookNotificationError =>
                error instanceof WebhookNotificationError
                  ? error
                  : new WebhookNotificationError("transport_failed"),
            }),
          );
          return { delivered: Result.isSuccess(delivery) };
        }),
      );
  }),
);
