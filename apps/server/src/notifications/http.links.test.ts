import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  NotificationWebhookChannel,
} from "@t3tools/contracts";
import { SecretResolver } from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import { expect, it } from "vite-plus/test";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import * as Settings from "../serverSettings.ts";
import * as NotificationsHttp from "./http.ts";
import { receiver } from "./notificationReceiver.testkit.ts";
import { WebPushService } from "./WebPushService.ts";

class NotificationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.notifications,
) {}

const decodeChannel = Schema.decodeSync(NotificationWebhookChannel);

it.each([null, "https://public.cox.example.com"])(
  "sends test notifications using configured public origin %s or request origin",
  async (publicBaseUrl) => {
    await using hook = await receiver(false);
    const channel = decodeChannel({
      id: "hook",
      label: "Phone",
      provider: "json",
      url: hook.endpoint,
      secret: "vault-secret",
      events: ["human_attention"],
      allowPrivateNetwork: true,
    });
    const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (httpEffect) =>
      Effect.provideService(httpEffect, EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("session"),
        subject: "owner",
        method: "browser-session-cookie",
        scopes: new Set([AuthOrchestrationOperateScope]),
      }),
    );
    const routes = HttpApiBuilder.layer(NotificationTestApi).pipe(
      Layer.provide(NotificationsHttp.layer),
      Layer.provide(auth),
      Layer.provide(Settings.layerTest({ notifications: { publicBaseUrl, webhooks: [channel] } })),
      Layer.provide(Layer.mock(WebPushService)({})),
      Layer.provide(Layer.mock(NotificationSubscriptionRepository)({})),
      Layer.provideMerge(Layer.mock(ServerSecretStore)({})),
      Layer.provideMerge(Layer.mock(SecretResolver)({})),
      Layer.provideMerge(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
      Layer.provide(NodeServices.layer),
    );
    const web = HttpRouter.toWebHandler(routes, { disableLogger: true });
    try {
      const result = await web.handler(
        new Request("http://127.0.0.1/api/notifications/test", {
          method: "POST",
          headers: { "content-type": "application/json", host: "127.0.0.1" },
          body: JSON.stringify({ target: "webhook", channelId: "hook" }),
        }),
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ delivered: true });
      expect(await hook.next()).toMatchObject({
        threadPath: "/settings/notifications",
        deepLinkUrl: `${publicBaseUrl ?? "http://127.0.0.1"}/settings/notifications`,
      });
    } finally {
      await web.dispose();
    }
  },
);
