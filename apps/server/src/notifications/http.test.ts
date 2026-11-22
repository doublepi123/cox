// allow: SIZE_OK — one integration harness (layer builder, loopback receivers, RFC 8291
// decryptor) plus one test per route contract, matching the auth/http.test.ts suite idiom.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Loopback receivers and RFC 8291 decryption are native Node APIs.
import { createDecipheriv, createECDH, createHmac, hkdfSync } from "node:crypto";
import type { LookupAddress } from "node:dns";

const http = process.getBuiltinModule("node:http");
type HttpServer = InstanceType<(typeof http)["Server"]>;
type IncomingMessage = InstanceType<(typeof http)["IncomingMessage"]>;
type ServerResponse = InstanceType<(typeof http)["ServerResponse"]>;
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  NotificationWebhookChannel,
  PushSubscriptionId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { describe } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as AuthHttp from "../auth/http.ts";
import * as NotificationSubscriptions from "../persistence/NotificationSubscriptions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { make as makeWebPush, WebPushService, type WebPushConfig } from "./WebPushService.ts";
import * as NotificationsHttp from "./http.ts";

class NotificationsTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.notifications) {}

const FIXED_EPOCH_MS = 1_730_000_000_000;
const clock = { millis: FIXED_EPOCH_MS };
const WEBHOOK_CHANNEL_ID = "ops-webhook";
const WEBHOOK_SECRET = "webhook-secret-value";

const subscriber = createECDH("prime256v1");
subscriber.setPrivateKey(Buffer.from("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94", "base64url"));
const pushKeys = {
  p256dh: subscriber.getPublicKey().toString("base64url"),
  auth: Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url").toString("base64url"),
};

const decodeChannel = Schema.decodeSync(NotificationWebhookChannel);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const webhookSecretName = `notifications.webhook.${Buffer.from(WEBHOOK_CHANNEL_ID, "utf8").toString("base64url")}.secret`;
const publicLookup = async (): Promise<readonly LookupAddress[]> => [
  { address: "93.184.216.34", family: 4 },
];
const defaultWebPushConfig: WebPushConfig = {
  allowLoopbackHttpForTest: true,
  lookup: publicLookup,
};

let capturedSecrets: Context.Context<ServerSecretStore.ServerSecretStore> | undefined;
let capturedSessionStore: Context.Context<SessionStore.SessionStore> | undefined;

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "cox-notifications-http-" });
const layerSqlite = SqlitePersistence.layerMemory;
// The notification routes read this clock; tests advance it to move the rate-limit window.
const controlledClock: Clock.Clock = {
  currentTimeMillis: Effect.sync(() => clock.millis),
  currentTimeMillisUnsafe: () => clock.millis,
  currentTimeNanos: Effect.sync(() => BigInt(clock.millis) * 1_000_000n),
  currentTimeNanosUnsafe: () => BigInt(clock.millis) * 1_000_000n,
  monotonicTimeNanos: Effect.succeed(0n),
  monotonicTimeNanosUnsafe: () => 0n,
  sleep: () => Effect.never,
};
const layerClock = Layer.succeed(Clock.Clock, controlledClock);

const layerRoutes = (
  webhookUrl: string,
  webPushEnabled = true,
  webPushConfig: WebPushConfig = defaultWebPushConfig,
) => {
  clock.millis = FIXED_EPOCH_MS;
  const layerSettings = ServerSettings.layerTest({
    notifications: {
      webPushEnabled,
      webhooks: [
        decodeChannel({
          id: WEBHOOK_CHANNEL_ID,
          label: "Ops hook",
          provider: "json",
          url: webhookUrl,
          secret: SECRET_REDACTED,
          allowPrivateNetwork: true,
          events: ["human_attention"],
        }),
      ],
    },
  });
  const layerSecrets = ServerSecretStore.layer.pipe(
    Layer.tap((secrets) =>
      Effect.sync(() => {
        capturedSecrets = secrets;
      }),
    ),
    Layer.provide(layerConfig),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerSessions = SessionStore.layer.pipe(
    Layer.tap((sessions) =>
      Effect.sync(() => {
        capturedSessionStore = sessions;
      }),
    ),
    Layer.provideMerge(layerSqlite),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(layerClock),
  );
  const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
    Layer.provideMerge(layerSessions),
    Layer.provideMerge(layerSecrets),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerConfig),
    Layer.provideMerge(layerSqlite),
  );
  const layerResolver = SecretResolver.layer.pipe(Layer.provideMerge(layerSettings));
  const layerNotifications = NotificationsHttp.layer.pipe(
    Layer.provide(Layer.effect(WebPushService, makeWebPush(webPushConfig))),
    Layer.provide(NotificationSubscriptions.layer.pipe(Layer.provideMerge(NodeCrypto.layer))),
    Layer.provideMerge(layerSqlite),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(layerSecrets),
  );
  return HttpApiBuilder.layer(NotificationsTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(layerNotifications),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provideMerge(layerResolver),
    Layer.provideMerge(layerSecrets),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(layerClock),
  );
};

interface ReceivedRequest {
  readonly headers: IncomingMessage["headers"];
  readonly body: Buffer;
}

interface LoopbackReceiver {
  readonly origin: string;
  readonly next: () => Promise<ReceivedRequest>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

const startReceiver = (respond: (response: ServerResponse) => void) =>
  Effect.promise(
    () =>
      new Promise<LoopbackReceiver>((resolve, reject) => {
        let arrived = Promise.withResolvers<ReceivedRequest>();
        const server: HttpServer = http.createServer((requestMessage, response) => {
          const chunks: Buffer[] = [];
          requestMessage.on("data", (chunk: Buffer) => chunks.push(chunk));
          requestMessage.on("end", () => {
            arrived.resolve({ headers: requestMessage.headers, body: Buffer.concat(chunks) });
            arrived = Promise.withResolvers();
            respond(response);
          });
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Expected a TCP listener"));
            return;
          }
          resolve({
            origin: `http://127.0.0.1:${address.port}`,
            next: () => arrived.promise,
            async [Symbol.asyncDispose]() {
              server.closeAllConnections();
              await new Promise<void>((closeResolve, closeReject) =>
                server.close((error) => (error ? closeReject(error) : closeResolve())),
              );
            },
          });
        });
      }),
  );

const acquireWebHandler = (
  webhookUrl: string,
  webPushEnabled = true,
  webPushConfig: WebPushConfig = defaultWebPushConfig,
) =>
  Effect.sync(() =>
    HttpRouter.toWebHandler(layerRoutes(webhookUrl, webPushEnabled, webPushConfig), {
      disableLogger: true,
      middleware: (effect) =>
        Effect.updateService(effect, HttpServerRequest.HttpServerRequest, (request) => {
          Object.assign(request.source, { remoteAddress: "127.0.0.1" });
          return request;
        }),
    }),
  );

const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      origin: "http://127.0.0.1",
      ...headers,
    },
    body: encodeJson(body),
  });

const request = (method: string, path: string, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method,
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", ...headers },
  });

const login = async (call: (request: Request) => Promise<Response>) => {
  const response = await call(postJson("/api/auth/browser-session", {}));
  expect(response.status).toBe(200);
  return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
};

const decryptWebPush = (body: Buffer): string => {
  const ephemeral = body.subarray(21, 86);
  const ikm = Buffer.from(
    hkdfSync(
      "sha256",
      subscriber.computeSecret(ephemeral),
      Buffer.from("BTBZMqHH6r4Tts7J_aSIgg", "base64url"),
      Buffer.concat([Buffer.from("WebPush: info\0"), subscriber.getPublicKey(), ephemeral]),
      32,
    ),
  );
  const salt = body.subarray(0, 16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(body.subarray(-16));
  const decrypted = Buffer.concat([decipher.update(body.subarray(86, -16)), decipher.final()]);
  return decrypted.subarray(0, decrypted.lastIndexOf("}") + 1).toString("utf8");
};

const withWebHandler = <A, E, R>(
  use: (call: (request: Request) => Promise<Response>) => Effect.Effect<A, E, R>,
  webhookUrl = "http://127.0.0.1:9/hook",
  webPushEnabled = true,
  webPushConfig: WebPushConfig = defaultWebPushConfig,
) =>
  Effect.acquireUseRelease(
    acquireWebHandler(webhookUrl, webPushEnabled, webPushConfig),
    (web) => use((request) => web.handler(request)),
    (web) => Effect.promise(() => web.dispose()),
  );

describe("notification HTTP routes", () => {
  it.effect("serves the VAPID key, binds subscriptions, and delivers test push and webhook", () =>
    Effect.acquireUseRelease(
      startReceiver((response) => {
        response.writeHead(201).end();
      }),
      (push) =>
        Effect.acquireUseRelease(
          startReceiver((response) => {
            response.end("ok");
          }),
          (webhook) =>
            Effect.acquireUseRelease(
              acquireWebHandler(`${webhook.origin}/hook`),
              (web) =>
                Effect.gen(function* () {
                  const call = (input: Request) => web.handler(input);
                  const cookie = yield* Effect.promise(() => login(call));
                  const secrets = capturedSecrets;
                  if (!secrets) throw new Error("Secret store was not captured");
                  yield* Context.get(secrets, ServerSecretStore.ServerSecretStore).create(
                    webhookSecretName,
                    new TextEncoder().encode(WEBHOOK_SECRET),
                  );

                  const vapid = yield* Effect.promise(() =>
                    call(request("GET", "/api/notifications/vapid-public-key", { cookie })),
                  );
                  expect(vapid.status).toBe(200);
                  const vapidBody = (yield* Effect.promise(() => vapid.json())) as {
                    publicKey: string;
                    enabled: boolean;
                  };
                  expect(vapidBody.enabled).toBe(true);
                  expect(vapidBody.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);

                  const created = yield* Effect.promise(() =>
                    call(
                      postJson(
                        "/api/notifications/push-subscriptions",
                        {
                          endpoint: `${push.origin}/push`,
                          keys: pushKeys,
                          label: "Pixel 9",
                          userAgent: "Mozilla/5.0 (Linux; Android 15)",
                        },
                        { cookie },
                      ),
                    ),
                  );
                  expect(created.status).toBe(200);
                  const subscription = (yield* Effect.promise(() => created.json())) as Record<
                    string,
                    unknown
                  >;
                  expect(subscription).toMatchObject({
                    sessionId: expect.any(String),
                    endpointOrigin: push.origin,
                    label: "Pixel 9",
                    lastDeliveredAt: null,
                  });
                  expect(Object.keys(subscription)).not.toContain("endpoint");
                  expect(Object.keys(subscription)).not.toContain("keys");
                  expect(JSON.stringify(subscription)).not.toContain(pushKeys.p256dh);

                  const listed = yield* Effect.promise(() =>
                    call(request("GET", "/api/notifications/push-subscriptions", { cookie })),
                  );
                  expect(listed.status).toBe(200);
                  const listBody = (yield* Effect.promise(() => listed.json())) as {
                    subscriptions: Array<Record<string, unknown>>;
                  };
                  expect(listBody.subscriptions).toHaveLength(1);
                  expect(listBody.subscriptions[0]).toMatchObject({
                    endpointOrigin: push.origin,
                  });
                  expect(JSON.stringify(listBody)).not.toContain(`${push.origin}/push`);

                  const pushArrived = push.next();
                  const testPush = yield* Effect.promise(() =>
                    call(postJson("/api/notifications/test", { target: "web_push" }, { cookie })),
                  );
                  expect(testPush.status).toBe(200);
                  expect(yield* Effect.promise(() => testPush.json())).toEqual({
                    delivered: true,
                  });
                  const receivedPush = yield* Effect.promise(() => pushArrived);
                  expect(receivedPush.headers).toMatchObject({
                    "content-encoding": "aes128gcm",
                    ttl: "86400",
                    urgency: "high",
                  });
                  expect(JSON.parse(decryptWebPush(receivedPush.body))).toEqual({
                    title: "Cox test notification",
                    body: "If you can read this, web push delivery works.",
                    tag: "cox-test",
                  });

                  const webhookArrived = webhook.next();
                  const testWebhook = yield* Effect.promise(() =>
                    call(
                      postJson(
                        "/api/notifications/test",
                        { target: "webhook", channelId: WEBHOOK_CHANNEL_ID },
                        { cookie },
                      ),
                    ),
                  );
                  expect(testWebhook.status).toBe(200);
                  expect(yield* Effect.promise(() => testWebhook.json())).toEqual({
                    delivered: true,
                  });
                  const receivedWebhook = yield* Effect.promise(() => webhookArrived);
                  const webhookBody = receivedWebhook.body.toString("utf8");
                  expect(JSON.parse(webhookBody)).toMatchObject({
                    event: "notifications.test",
                    kind: "human_attention",
                    title: "Cox test notification",
                    body: "If you can read this, webhook delivery works.",
                    threadPath: "/settings/notifications",
                    deepLinkUrl: "http://127.0.0.1/settings/notifications",
                    timestamp: "2024-10-27T03:33:20.000Z",
                  });
                  expect(receivedWebhook.headers["x-cox-signature-256"]).toBe(
                    `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(webhookBody).digest("hex")}`,
                  );
                }),
              (web) => Effect.promise(() => web.dispose()),
            ),
          (webhook) => Effect.promise(() => webhook[Symbol.asyncDispose]()),
        ),
      (push) => Effect.promise(() => push[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("reflects the webPushEnabled setting in the VAPID key response", () =>
    withWebHandler(
      (call) =>
        Effect.gen(function* () {
          const cookie = yield* Effect.promise(() => login(call));
          const response = yield* Effect.promise(() =>
            call(request("GET", "/api/notifications/vapid-public-key", { cookie })),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            enabled: false,
          });
        }),
      "http://127.0.0.1:9/hook",
      false,
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("requires authentication and the app's own origin", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        const anonymous = yield* Effect.promise(() =>
          call(request("GET", "/api/notifications/vapid-public-key")),
        );
        expect(anonymous.status).toBe(401);
        expect(yield* Effect.promise(() => anonymous.json())).toMatchObject({
          _tag: "EnvironmentAuthInvalidError",
        });

        const cookie = yield* Effect.promise(() => login(call));
        const crossSite = yield* Effect.promise(() =>
          call(
            request("GET", "/api/notifications/vapid-public-key", {
              cookie,
              origin: "https://evil.example",
              "sec-fetch-site": "cross-site",
            }),
          ),
        );
        expect(crossSite.status).toBe(401);
        expect(yield* Effect.promise(() => crossSite.json())).toMatchObject({
          _tag: "EnvironmentAuthInvalidError",
        });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("rejects sessions without the orchestration operate scope", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => login(call));
        const sessions = capturedSessionStore;
        if (!sessions) throw new Error("Session store was not captured");
        const readOnly = yield* Context.get(sessions, SessionStore.SessionStore)
          .issue({ scopes: [AuthOrchestrationReadScope] })
          .pipe(Effect.provideService(Clock.Clock, controlledClock));
        const response = yield* Effect.promise(() =>
          call(
            request("GET", "/api/notifications/vapid-public-key", {
              authorization: `Bearer ${readOnly.token}`,
            }),
          ),
        );
        expect(response.status).toBe(403);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "EnvironmentScopeRequiredError",
          requiredScope: "orchestration:operate",
        });
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("deletes subscriptions only for the owning session", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        const cookieA = yield* Effect.promise(() => login(call));
        const cookieB = yield* Effect.promise(() => login(call));
        const created = yield* Effect.promise(() =>
          call(
            postJson(
              "/api/notifications/push-subscriptions",
              {
                endpoint: "https://push.example.com/sub/owner",
                keys: pushKeys,
                label: "Phone A",
              },
              { cookie: cookieA },
            ),
          ),
        );
        expect(created.status).toBe(200);
        const { id } = (yield* Effect.promise(() => created.json())) as { id: string };

        const foreignDelete = yield* Effect.promise(() =>
          call(
            request("DELETE", `/api/notifications/push-subscriptions/${id}`, {
              cookie: cookieB,
            }),
          ),
        );
        expect(foreignDelete.status).toBe(404);
        expect(yield* Effect.promise(() => foreignDelete.json())).toMatchObject({
          _tag: "EnvironmentResourceNotFoundError",
          reason: "push_subscription_not_found",
        });

        const surviving = yield* Effect.promise(() =>
          call(request("GET", "/api/notifications/push-subscriptions", { cookie: cookieA })),
        );
        const listBody = (yield* Effect.promise(() => surviving.json())) as {
          subscriptions: unknown[];
        };
        expect(listBody.subscriptions).toHaveLength(1);

        const ownedDelete = yield* Effect.promise(() =>
          call(
            request("DELETE", `/api/notifications/push-subscriptions/${id}`, {
              cookie: cookieA,
            }),
          ),
        );
        expect(ownedDelete.status).toBe(200);
        expect(yield* Effect.promise(() => ownedDelete.json())).toEqual({ deleted: true });

        const repeatedDelete = yield* Effect.promise(() =>
          call(
            request("DELETE", `/api/notifications/push-subscriptions/${id}`, {
              cookie: cookieA,
            }),
          ),
        );
        expect(repeatedDelete.status).toBe(404);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("rate limits test dispatches to five per minute and recovers after the window", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        const cookie = yield* Effect.promise(() => login(call));
        for (let attempt = 0; attempt < 5; attempt++) {
          const response = yield* Effect.promise(() =>
            call(postJson("/api/notifications/test", { target: "web_push" }, { cookie })),
          );
          expect(response.status).toBe(400);
        }
        const limited = yield* Effect.promise(() =>
          call(postJson("/api/notifications/test", { target: "web_push" }, { cookie })),
        );
        expect(limited.status).toBe(429);
        expect(yield* Effect.promise(() => limited.json())).toMatchObject({
          _tag: "EnvironmentNotificationTestRateLimitedError",
          code: "test_rate_limited",
          retryAfterSeconds: 60,
        });

        clock.millis += 61_000;
        const recovered = yield* Effect.promise(() =>
          call(postJson("/api/notifications/test", { target: "web_push" }, { cookie })),
        );
        expect(recovered.status).toBe(400);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("enforces the push endpoint transport policy at registration", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        const cookie = yield* Effect.promise(() => login(call));
        for (const endpoint of ["ftp://push.example.com/sub"]) {
          const response = yield* Effect.promise(() =>
            call(
              postJson(
                "/api/notifications/push-subscriptions",
                { endpoint, keys: pushKeys, label: "Phone" },
                { cookie },
              ),
            ),
          );
          expect(response.status).toBe(400);
        }
        for (const endpoint of ["http://192.168.1.5/push"]) {
          const response = yield* Effect.promise(() =>
            call(
              postJson(
                "/api/notifications/push-subscriptions",
                { endpoint, keys: pushKeys, label: "Phone" },
                { cookie },
              ),
            ),
          );
          expect(response.status).toBe(400);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            _tag: "EnvironmentRequestInvalidError",
          });
        }
        for (const endpoint of ["http://127.0.0.1:9/push", "https://push.example.com/sub"]) {
          const response = yield* Effect.promise(() =>
            call(
              postJson(
                "/api/notifications/push-subscriptions",
                { endpoint, keys: pushKeys, label: "Phone" },
                { cookie },
              ),
            ),
          );
          expect(response.status).toBe(200);
        }
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("rejects SSRF destinations before persisting subscriptions", () =>
    withWebHandler(
      (call) =>
        Effect.gen(function* () {
          const cookie = yield* Effect.promise(() => login(call));
          for (const endpoint of [
            "https://169.254.169.254/push",
            "https://127.0.0.1/push",
            "https://[fe80::1]/push",
            "https://rebind.example/push",
          ]) {
            const response = yield* Effect.promise(() =>
              call(
                postJson(
                  "/api/notifications/push-subscriptions",
                  { endpoint, keys: pushKeys, label: "Phone" },
                  { cookie },
                ),
              ),
            );
            expect(response.status).toBe(400);
            const listed = yield* Effect.promise(() =>
              call(request("GET", "/api/notifications/push-subscriptions", { cookie })),
            );
            expect(listed.status).toBe(200);
            expect(yield* Effect.promise(() => listed.json())).toEqual({ subscriptions: [] });
          }
        }),
      "http://127.0.0.1:9/hook",
      true,
      {
        lookup: async (hostname) =>
          hostname === "rebind.example" ? [{ address: "10.0.0.1", family: 4 }] : publicLookup(),
      },
    ),
  );

  it.effect("rejects unknown webhook channels and subscription ids", () =>
    withWebHandler((call) =>
      Effect.gen(function* () {
        const cookie = yield* Effect.promise(() => login(call));
        const unknownChannel = yield* Effect.promise(() =>
          call(
            postJson(
              "/api/notifications/test",
              { target: "webhook", channelId: "missing-channel" },
              { cookie },
            ),
          ),
        );
        expect(unknownChannel.status).toBe(400);
        const unknownSubscription = yield* Effect.promise(() =>
          call(
            postJson(
              "/api/notifications/test",
              { target: "web_push", subscriptionId: PushSubscriptionId.make("missing") },
              { cookie },
            ),
          ),
        );
        expect(unknownSubscription.status).toBe(400);
      }),
    ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
