import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthMcpClientAccess,
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class AuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-oauth-test-" });
const layerEnvironmentAuth = (config: ReturnType<typeof ServerConfig.layerTest>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provide(Sqlite.layerMemory),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerEnvironment.layerIdentity),
    Layer.provide(config),
  );
const makeLayerRoutes = (
  capture: (auth: EnvironmentAuth.EnvironmentAuth["Service"]) => void,
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
) => {
  const config = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      return { ...(yield* ServerConfig.ServerConfig), ...overrides };
    }),
  ).pipe(Layer.provide(layerConfig));
  return Layer.mergeAll(
    Layer.effectDiscard(
      EnvironmentAuth.EnvironmentAuth.pipe(Effect.tap((auth) => Effect.sync(() => capture(auth)))),
    ),
    HttpApiBuilder.layer(AuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(
        McpOAuthHttp.layer.pipe(
          Layer.provide(McpOAuth.layer),
          Layer.provide(ServerSettings.layerTest()),
        ),
      ),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provideMerge(layerEnvironmentAuth(config)),
    Layer.provide(config),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const ORIGIN = "http://127.0.0.1";
const REDIRECT = "http://localhost/callback";
const verifier = "a".repeat(43) + "-verifier-for-tests";
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";

const at = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { host: "127.0.0.1", origin: ORIGIN, ...init?.headers },
  });
const form = (body: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

type Handler = (request: Request) => Effect.Effect<Response>;

const withRoutes = <A, E>(
  use: (handler: Handler, auth: EnvironmentAuth.EnvironmentAuth["Service"]) => Effect.Effect<A, E>,
  overrides?: Partial<ServerConfig.ServerConfig["Service"]>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let routerAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;
    const layerRoutes = makeLayerRoutes((auth) => {
      routerAuth = auth;
    }, overrides);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(layerRoutes, {
          disableLogger: true,
          middleware: (effect) =>
            Effect.updateService(effect, HttpServerRequest.HttpServerRequest, (request) => {
              Object.assign(request.source, { remoteAddress: "127.0.0.1" });
              return request;
            }),
        }),
      ),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          yield* handler(at("/.well-known/oauth-authorization-server"));
          return yield* use(handler, routerAuth!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);

const postJson = (path: string, body: unknown, cookie?: string) =>
  at(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: encodeJson(body),
  });

const decide = (
  handler: Handler,
  authorization: Record<string, string>,
  decision: Record<string, string>,
  cookie?: string,
) =>
  handler(postJson("/oauth/mcp/decision", { authorization, decision }, cookie)).pipe(
    Effect.flatMap((response) =>
      Effect.promise(async () => {
        const text = await response.text();
        return text ? (JSON.parse(text) as { redirectTo?: string; message?: string }) : {};
      }).pipe(Effect.map((payload) => ({ status: response.status, ...payload }))),
    ),
  );

const browserCookie = (handler: Handler) =>
  handler(postJson("/api/auth/browser-session", {})).pipe(
    Effect.map((response) => {
      expect(response.status).toBe(200);
      return response.headers.getSetCookie()[0]!.split(";", 1)[0]!;
    }),
  );

const approveWithBrowser = (handler: Handler, params: Record<string, string>, access: string) =>
  Effect.gen(function* () {
    const cookie = yield* browserCookie(handler);
    const details = yield* handler(postJson("/oauth/mcp/approval", params, cookie)).pipe(
      Effect.flatMap(json<{ csrfToken: string }>),
    );
    return yield* decide(
      handler,
      params,
      {
        _tag: "browser-session",
        access,
        csrfToken: details.csrfToken,
      },
      cookie,
    );
  });

const register = (handler: Handler, redirect = REDIRECT) =>
  handler(
    at("/oauth/mcp/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: encodeJson({
        client_name: "Claude Code",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );

const registeredClientId = (handler: Handler) =>
  register(handler).pipe(
    Effect.flatMap((response) => json<{ client_id: string }>(response)),
    Effect.map((body) => body.client_id),
  );

const authorizeParams = (clientId: string, redirect = "http://localhost:51234/callback") => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: redirect,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "state-1",
  resource: `${ORIGIN}/mcp`,
});

it.live("derives discovery metadata from the origin the client reached", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const resource = yield* handler(at("/.well-known/oauth-protected-resource/mcp"));
      expect(yield* json<unknown>(resource)).toMatchObject({
        resource: `${ORIGIN}/mcp`,
        authorization_servers: [ORIGIN],
      });
      const server = yield* json<unknown>(
        yield* handler(at("/.well-known/oauth-authorization-server")),
      );
      expect(server).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/oauth/mcp/authorize`,
        token_endpoint: `${ORIGIN}/oauth/mcp/token`,
        registration_endpoint: `${ORIGIN}/oauth/mcp/register`,
        code_challenge_methods_supported: ["S256"],
      });
    }),
  ),
);

it.live("registers loopback and https clients and never redirects for an unverified client", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      for (const refused of [
        "http://bot.example/callback",
        "https://user:pass@bot.example/callback",
        "https://bot.example/callback#",
        "http://localhost/callback#",
        "javascript:alert(1)",
      ]) {
        const response = yield* register(handler, refused);
        expect(response.status).toBe(400);
        expect(yield* json<unknown>(response)).toMatchObject({ error: "invalid_redirect_uri" });
      }

      const registered = yield* register(handler);
      expect(registered.status).toBe(201);
      const { client_id: clientId } = (yield* json<unknown>(registered)) as { client_id: string };

      const forged = yield* handler(
        at(
          `/oauth/mcp/authorize?${new URLSearchParams(authorizeParams(`${clientId.split(".")[0]}.forged`))}`,
        ),
      );
      expect(forged.status).toBe(400);
      expect(forged.headers.get("location")).toBeNull();

      const unregistered = yield* handler(
        at(
          `/oauth/mcp/authorize?${new URLSearchParams(
            authorizeParams(clientId, "http://localhost:51234/elsewhere"),
          )}`,
        ),
      );
      expect(unregistered.status).toBe(400);
      expect(unregistered.headers.get("location")).toBeNull();

      const query = new URLSearchParams(authorizeParams(clientId)).toString();
      const handoff = yield* handler(at(`/oauth/mcp/authorize?${query}`));
      expect(handoff.status).toBe(200);
      expect(handoff.headers.get("location")).toBeNull();
      const page = yield* Effect.promise(() => handoff.text());
      expect(page).toContain('data-login-mode="local"');
      expect(page).toContain('id="approve" hidden');
      expect(page).not.toContain("/connect-agent");
      const details = yield* handler(
        postJson("/oauth/mcp/approval", authorizeParams(clientId)),
      ).pipe(Effect.flatMap(json<Record<string, unknown>>));
      expect(details).toEqual({
        clientName: "Claude Code",
        redirectHost: "localhost:51234",
        environmentHost: "127.0.0.1",
      });

      const forgedDetails = yield* handler(
        postJson("/oauth/mcp/approval", authorizeParams(`${clientId.split(".")[0]}.forged`)),
      );
      expect(forgedDetails.status).toBe(400);
      expect(yield* json<Record<string, unknown>>(forgedDetails)).not.toHaveProperty("redirectTo");
    }),
  ),
);

it.live("signs in with explicit browser approval and issues a token only /mcp accepts", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const params = authorizeParams(clientId);

      const approved = yield* approveWithBrowser(handler, params, "auto");
      expect(approved.status).toBe(200);
      const callback = new URL(approved.redirectTo!);
      expect(callback.origin).toBe("http://localhost:51234");
      expect(callback.searchParams.get("state")).toBe("state-1");
      expect(callback.searchParams.get("iss")).toBe(ORIGIN);
      const code = callback.searchParams.get("code")!;

      const exchange = (codeVerifier: string) =>
        handler(
          at(
            "/oauth/mcp/token",
            form({
              grant_type: "authorization_code",
              code,
              redirect_uri: params.redirect_uri,
              client_id: clientId,
              code_verifier: codeVerifier,
              resource: `${ORIGIN}/mcp`,
            }),
          ),
        );
      const tokenResponse = yield* exchange(verifier);
      expect(tokenResponse.status).toBe(200);
      const token = (yield* json<unknown>(tokenResponse)) as {
        access_token: string;
        scope: string;
      };
      expect(token.scope).toBe("orchestration:read orchestration:operate");

      expect((yield* exchange(verifier)).status).toBe(400);

      const client = yield* auth.authenticateMcpClient(
        HttpServerRequest.fromWeb(
          at("/mcp", { headers: { authorization: `Bearer ${token.access_token}` } }),
        ),
      );
      expect(client).toMatchObject({ label: "Claude Code", access: "auto" });

      const session = yield* handler(
        at("/api/auth/session", { headers: { authorization: `Bearer ${token.access_token}` } }),
      );
      expect(yield* json<unknown>(session)).toMatchObject({ authenticated: false });
      const ticket = yield* handler(
        at("/api/auth/websocket-ticket", {
          method: "POST",
          headers: { authorization: `Bearer ${token.access_token}` },
        }),
      );
      expect(ticket.status).toBe(401);
    }),
  ),
);

it.live("signs in a hosted agent with an https callback that asked for a client secret", () =>
  withRoutes((handler, auth) =>
    Effect.gen(function* () {
      const callbackUrl = "https://bot.example/oauth/callback";
      const registered = yield* handler(
        at("/oauth/mcp/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: encodeJson({
            client_name: "Hosted bot",
            redirect_uris: [callbackUrl],
            token_endpoint_auth_method: "client_secret_post",
          }),
        }),
      );
      expect(registered.status).toBe(201);
      const client = (yield* json<unknown>(registered)) as {
        client_id: string;
        token_endpoint_auth_method: string;
      };
      expect(client.token_endpoint_auth_method).toBe("none");

      const params = authorizeParams(client.client_id, callbackUrl);
      const details = yield* handler(postJson("/oauth/mcp/approval", params)).pipe(
        Effect.flatMap(json<Record<string, unknown>>),
      );
      expect(details).toMatchObject({ clientName: "Hosted bot", redirectHost: "bot.example" });

      const approved = yield* approveWithBrowser(handler, params, "approval-required");
      const callback = new URL(approved.redirectTo!);
      expect(`${callback.origin}${callback.pathname}`).toBe(callbackUrl);

      const tokenResponse = yield* handler(
        at(
          "/oauth/mcp/token",
          form({
            grant_type: "authorization_code",
            code: callback.searchParams.get("code")!,
            redirect_uri: callbackUrl,
            client_id: client.client_id,
            client_secret: "unused",
            code_verifier: verifier,
          }),
        ),
      );
      expect(tokenResponse.status).toBe(200);
      const token = (yield* json<unknown>(tokenResponse)) as { access_token: string };
      const signedIn = yield* auth.authenticateMcpClient(
        HttpServerRequest.fromWeb(
          at("/mcp", { headers: { authorization: `Bearer ${token.access_token}` } }),
        ),
      );
      expect(signedIn).toMatchObject({ label: "Hosted bot", access: "approval-required" });
    }),
  ),
);

it.live("rejects a wrong PKCE verifier and spends the code", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const params = authorizeParams(clientId);
      const approved = yield* approveWithBrowser(handler, params, "approval-required");
      const code = new URL(approved.redirectTo!).searchParams.get("code")!;
      const exchange = (codeVerifier: string) =>
        handler(
          at(
            "/oauth/mcp/token",
            form({
              grant_type: "authorization_code",
              code,
              redirect_uri: params.redirect_uri,
              client_id: clientId,
              code_verifier: codeVerifier,
            }),
          ),
        );
      const wrong = yield* exchange("b".repeat(64));
      expect(wrong.status).toBe(400);
      expect(yield* json<unknown>(wrong)).toMatchObject({ error: "invalid_grant" });
      expect((yield* exchange(verifier)).status).toBe(400);
    }),
  ),
);

it.live("denies requests and rejects absent, forged, or mismatched browser consent", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const params = authorizeParams(yield* registeredClientId(handler));
      const denied = yield* decide(handler, params, { _tag: "deny" });
      const deniedUrl = new URL(denied.redirectTo!);
      expect(deniedUrl.searchParams.get("error")).toBe("access_denied");
      expect(deniedUrl.searchParams.get("state")).toBe("state-1");
      const cookie = yield* browserCookie(handler);
      const details = yield* handler(postJson("/oauth/mcp/approval", params, cookie)).pipe(
        Effect.flatMap(json<{ csrfToken: string }>),
      );
      for (const [authorization, csrfToken, sessionCookie] of [
        [params, details.csrfToken, undefined],
        [params, "forged", cookie],
        [{ ...params, redirect_uri: "http://localhost:60000/callback" }, details.csrfToken, cookie],
        [{ ...params, code_challenge: "b".repeat(43) }, details.csrfToken, cookie],
      ] as const) {
        const rejected = yield* decide(
          handler,
          authorization,
          {
            _tag: "browser-session",
            access: "auto",
            csrfToken,
          },
          sessionCookie,
        );
        expect(rejected.status).toBe(400);
        expect(rejected.redirectTo).toBeUndefined();
      }
      for (const decision of [
        { _tag: "credential", credential: "password", access: "auto" },
        { _tag: "password", password: "password", access: "auto" },
      ]) {
        expect((yield* decide(handler, params, decision, cookie)).status).toBe(400);
      }
    }),
  ),
);

it.live("requires explicit browser consent for every supported access level", () =>
  withRoutes((handler) =>
    Effect.gen(function* () {
      const params = authorizeParams(yield* registeredClientId(handler));
      const cookie = yield* browserCookie(handler);
      const details = yield* handler(postJson("/oauth/mcp/approval", params, cookie)).pipe(
        Effect.flatMap(json<{ csrfToken: string; oneClickAccess: ReadonlyArray<string> }>),
      );
      expect(details.oneClickAccess).toEqual(AuthMcpClientAccess.literals);
      for (const access of AuthMcpClientAccess.literals) {
        const approved = yield* decide(
          handler,
          params,
          {
            _tag: "browser-session",
            access,
            csrfToken: details.csrfToken,
          },
          cookie,
        );
        expect(approved.status).toBe(200);
        expect(new URL(approved.redirectTo!).searchParams.get("code")).toEqual(expect.any(String));
      }
      const handoff = yield* handler(
        at("/oauth/mcp/authorize?" + new URLSearchParams(params), { headers: { cookie } }),
      );
      expect(handoff.status).toBe(200);
      expect(handoff.headers.get("location")).toBeNull();
      expect(handoff.headers.getSetCookie()).toEqual([]);
      expect(yield* Effect.promise(() => handoff.text())).toContain("Allow access");
    }),
  ),
);

it.live("password sign-in preserves the authorization and still requires explicit consent", () =>
  withRoutes(
    (handler) =>
      Effect.gen(function* () {
        const params = authorizeParams(yield* registeredClientId(handler));
        const query = new URLSearchParams(params).toString();
        const page = yield* handler(at(`/oauth/mcp/authorize?${query}`));
        expect(page.status).toBe(200);
        expect(page.headers.getSetCookie()).toEqual([]);
        expect(page.headers.get("content-security-policy")).toContain("script-src 'sha256-");
        expect(page.headers.get("content-security-policy")).toContain("connect-src 'self'");
        const html = yield* Effect.promise(() => page.text());
        expect(html).toContain('data-login-mode="password"');
        expect(html).toContain('type="password"');
        expect(html).toContain(query.replaceAll("&", "&amp;"));
        const missing = yield* handler(postJson("/api/auth/browser-session", {}));
        expect(missing.status).toBe(401);
        const wrong = yield* handler(
          postJson("/api/auth/browser-session", { credential: "wrong" }),
        );
        expect(wrong.status).toBe(401);
        const signedIn = yield* handler(
          postJson("/api/auth/browser-session", { credential: "test-password-for-mcp" }),
        );
        expect(signedIn.status).toBe(200);
        const cookie = signedIn.headers.getSetCookie()[0]!.split(";", 1)[0]!;
        const details = yield* handler(postJson("/oauth/mcp/approval", params, cookie)).pipe(
          Effect.flatMap(json<{ csrfToken: string }>),
        );
        expect(details.csrfToken).toEqual(expect.any(String));
        const consent = yield* handler(
          at(`/oauth/mcp/authorize?${query}`, { headers: { cookie } }),
        );
        expect(consent.status).toBe(200);
        expect(consent.headers.get("location")).toBeNull();
        const approved = yield* decide(
          handler,
          params,
          {
            _tag: "browser-session",
            access: "read-only",
            csrfToken: details.csrfToken,
          },
          cookie,
        );
        expect(approved.status).toBe(200);
        expect(new URL(approved.redirectTo!).searchParams.get("state")).toBe(params.state);
        expect(new URL(approved.redirectTo!).searchParams.get("code")).toEqual(expect.any(String));
      }),
    { authPassword: Redacted.make("test-password-for-mcp") },
  ),
);

it("matches loopback redirects on everything but the port, and https redirects exactly", () => {
  const matches = McpOAuth.redirectMatches;
  expect(matches("http://localhost/callback", "http://localhost:9/callback")).toBe(true);
  expect(matches("http://127.0.0.1:1/callback", "http://127.0.0.1:2/callback")).toBe(true);
  expect(matches("http://localhost/callback", "http://127.0.0.1/callback")).toBe(false);
  expect(matches("http://localhost/callback", "https://localhost/callback")).toBe(false);
  expect(matches("https://bot.example/cb", "https://bot.example/cb")).toBe(true);
  expect(matches("https://bot.example/cb", "https://bot.example:8443/cb")).toBe(false);
  expect(matches("https://bot.example/cb", "https://bot.example/cb?x=1")).toBe(false);
  expect(matches("https://bot.example/cb", "https://evil.example/cb")).toBe(false);
});

it.effect("a browser may only approve scopes it holds", () => {
  let scopes: ReadonlyArray<AuthEnvironmentScope> = ["access:write", "orchestration:read"];
  const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth)({
    authenticateBrowserSession: () =>
      Effect.succeed({
        sessionId: AuthSessionId.make("scope-test-session"),
        subject: "local",
        method: "browser-session-cookie",
        scopes,
      }),
  });
  return Effect.gen(function* () {
    const oauth = yield* McpOAuth.McpOAuth;
    const client = yield* oauth.register({ redirect_uris: [REDIRECT] });
    const authorization = yield* oauth.validateAuthorization({
      urls: { issuer: ORIGIN, resource: `${ORIGIN}/mcp` },
      request: { ...authorizeParams(client.clientId), state: Redacted.make("state-1") },
    });
    const request = HttpServerRequest.fromWeb(at("/oauth/mcp/decision"));
    const browser = yield* oauth.approvingBrowserSession(request, authorization);
    expect(browser?.csrfToken).toEqual(expect.any(String));
    const refused = yield* oauth
      .approve({
        request,
        authorization,
        decision: { _tag: "browser-session", access: "auto", csrfToken: browser!.csrfToken },
      })
      .pipe(Effect.result);
    expect(refused._tag).toBe("Failure");
    const allowed = yield* oauth.approve({
      request,
      authorization,
      decision: { _tag: "browser-session", access: "read-only", csrfToken: browser!.csrfToken },
    });
    expect(new URL(allowed).searchParams.get("code")).toEqual(expect.any(String));
    scopes = ["orchestration:read", "orchestration:operate"];
    expect(yield* oauth.approvingBrowserSession(request, authorization)).toBeUndefined();
    scopes = ["access:read", "access:write"];
    expect(yield* oauth.approvingBrowserSession(request, authorization)).toBeUndefined();
  }).pipe(
    Effect.provide(
      McpOAuth.layer.pipe(
        Layer.provide(auth),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(layerConfig),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});
