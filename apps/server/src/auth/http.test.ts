import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "cox-auth-http-test-" });

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides };
    }),
  ).pipe(Layer.provide(layerConfig));

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );
const layerRoutes = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provideMerge(layerEnvironmentAuth(overrides)),
    Layer.provide(layerServerConfig(overrides)),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
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

it.effect.each(["DPoP", "dpop", "dPoP"])("challenges a refused %s request with DPoP", (scheme) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes(), { disableLogger: true })),
      (web) =>
        Effect.promise(async () => {
          const response = await web.handler(
            postJson(
              "/api/auth/websocket-ticket",
              {},
              {
                authorization: `${scheme} invalid-test-token`,
              },
            ),
            requestContext,
          );
          expect(response.status).toBe(401);
          expect(response.headers.get("www-authenticate")).toBe("DPoP");
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates isolated local sessions, checks origin, and sets safe cookies", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layerRoutes(), {
          disableLogger: true,
          middleware: (effect) =>
            Effect.updateService(effect, HttpServerRequest.HttpServerRequest, (request) => {
              Object.assign(request.source, { remoteAddress: "127.0.0.1" });
              return request;
            }),
        }),
      ),
      (web) =>
        Effect.tryPromise(async () => {
          const response = await web.handler(
            postJson("/api/auth/browser-session", {}),
            requestContext,
          );
          expect(response.status).toBe(200);
          const cookie = response.headers.getSetCookie()[0]!;
          expect(cookie).toMatch(/^cox_session_/);
          expect(cookie).toContain("HttpOnly");
          expect(cookie).toContain("SameSite=Lax");
          expect(cookie).toContain("Path=/");
          expect(cookie).not.toContain("Secure");
          const session = await web.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { host: "127.0.0.1", cookie: cookie.split(";", 1)[0]! },
            }),
            requestContext,
          );
          expect(await session.json()).toMatchObject({ authenticated: true });
          const forgedOrigin = await web.handler(
            postJson(
              "/api/auth/browser-session",
              {},
              {
                origin: "https://evil.example",
              },
            ),
            requestContext,
          );
          expect(forgedOrigin.status).not.toBe(200);
          expect(forgedOrigin.headers.getSetCookie()).toEqual([]);
          const forwarded = await web.handler(
            postJson(
              "/api/auth/browser-session",
              {},
              {
                "x-forwarded-proto": "https",
              },
            ),
            requestContext,
          );
          expect(forwarded.status).toBe(200);
          expect(forwarded.headers.getSetCookie()[0]).not.toContain("Secure");
          const secure = await web.handler(
            new Request("https://127.0.0.1/api/auth/browser-session", {
              method: "POST",
              headers: {
                "content-type": "application/json",
                host: "127.0.0.1",
                origin: "https://127.0.0.1",
              },
              body: "{}",
            }),
            requestContext,
          );
          expect(secure.status).toBe(200);
          expect(secure.headers.getSetCookie()[0]).toContain("Secure");
          const retired = await web.handler(postJson("/oauth/token", {}), requestContext);
          expect(retired.status).toBe(404);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("returns 429 with Retry-After while password attempts are throttled", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layerRoutes({ authPassword: Redacted.make("correct-password") }), {
          disableLogger: true,
          middleware: (effect) =>
            Effect.updateService(effect, HttpServerRequest.HttpServerRequest, (request) => {
              Object.assign(request.source, { remoteAddress: "127.0.0.1" });
              return request;
            }),
        }),
      ),
      (web) =>
        Effect.tryPromise(async () => {
          for (let attempt = 0; attempt < 10; attempt++) {
            const response = await web.handler(
              postJson("/api/auth/browser-session", { credential: "wrong-password" }),
              requestContext,
            );
            expect(response.status).toBe(401);
          }
          const response = await web.handler(
            postJson("/api/auth/browser-session", { credential: "correct-password" }),
            requestContext,
          );
          expect(response.status).toBe(429);
          expect(response.headers.get("retry-after")).toBe("300");
          expect(await response.json()).toMatchObject({
            _tag: "EnvironmentAuthRateLimitedError",
            code: "auth_rate_limited",
            retryAfterSeconds: 300,
            traceId: expect.any(String),
          });
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
