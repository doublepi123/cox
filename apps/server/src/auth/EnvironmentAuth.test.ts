import * as NodeServices from "@effect/platform-node/NodeServices";
import { authScopeResponse, AuthStandardClientScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";

import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";

const TEST_SERVER_PORT = 13_773;

it.each(["Bearer", "bearer", "bEaReR", "DPoP", "dpop", "dPoP"])(
  "selects %s without altering the case-sensitive credential",
  (scheme) => {
    expect(
      EnvironmentAuth.selectRequestCredential(
        request({ authorization: `${scheme} CaseSensitiveToken` }),
        "session",
        undefined,
      ),
    ).toEqual({
      token: "CaseSensitiveToken",
      source: scheme.toLowerCase() === "dpop" ? "dpop" : "bearer",
    });
  },
);

const layerServerConfig = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
        port: TEST_SERVER_PORT,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-server-test-" })));

const layerEnvironmentAuth = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuth.layer.pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(layerServerConfig(overrides)),
  );

const metadata = { deviceType: "desktop" as const, ipAddress: "127.0.0.1" };
const password = "correct-horse-password";
type AuthRequest = Parameters<
  EnvironmentAuth.EnvironmentAuth["Service"]["authenticateHttpRequest"]
>[0];
const request = (
  headers: Record<string, string> = {},
  cookies: Record<string, string> = {},
  peer = "127.0.0.1",
): AuthRequest =>
  ({
    headers: { host: `127.0.0.1:${TEST_SERVER_PORT}`, ...headers },
    cookies,
    source: { socket: { remoteAddress: peer } },
  }) as unknown as AuthRequest;

it.layer(NodeServices.layer)("EnvironmentAuth.layer", (it) => {
  it.effect("establishes a local browser session without credentials", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      yield* auth.assertBrowserSessionRequest(request());
      const issued = yield* auth.createBrowserSession(undefined, metadata);
      expect(issued.response).toMatchObject(authScopeResponse(AuthStandardClientScopes));
      const state = yield* auth.getSessionState(
        request({}, { [sessions.cookieName]: issued.sessionToken }),
      );
      expect(state.authenticated).toBe(true);
      expect(state.auth.loginMode).toBe("local");
      expect(
        (yield* auth.getSessionState(
          request({}, { [sessions.cookieName]: issued.sessionToken }, "192.168.1.2"),
        )).authenticated,
      ).toBe(false);
      expect((yield* sessions.verify(issued.sessionToken)).subject).toBe("local");
      expect(
        (yield* Effect.flip(auth.createBrowserSession("old-pairing-token", metadata)))._tag,
      ).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect.each([
    { headers: { host: "evil.example" }, peer: "127.0.0.1" },
    { headers: { host: "127.evil.example" }, peer: "127.0.0.1" },
    { headers: {}, peer: "192.168.1.2" },
    { headers: {}, peer: "" },
    { headers: { origin: "https://evil.example" }, peer: "127.0.0.1" },
    { headers: { "sec-fetch-site": "cross-site" }, peer: "127.0.0.1" },
    { headers: { "x-forwarded-host": "127.0.0.1" }, peer: "127.0.0.1" },
    { headers: { "x-forwarded-for": "127.0.0.1" }, peer: "127.0.0.1" },
    { headers: { forwarded: "for=127.0.0.1" }, peer: "127.0.0.1" },
  ])("rejects unsafe local session establishment: %j", ({ headers, peer }) =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const failure = yield* Effect.flip(
        auth.assertBrowserSessionRequest(request(headers, {}, peer)),
      );
      expect(failure._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect.each(["127.0.0.1", "::1", "::ffff:127.0.0.1"])("accepts loopback peers: %s", (peer) =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      yield* auth.assertBrowserSessionRequest(request({}, {}, peer));
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("does not trust a same-origin hint over a foreign Origin", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const failure = yield* Effect.flip(
        auth.assertBrowserSessionRequest(
          request({
            origin: "https://evil.example",
            "sec-fetch-site": "same-origin",
          }),
        ),
      );
      expect(failure._tag).toBe("ServerAuthInvalidCredentialError");
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("requires the password even for a local browser and replaces its old session", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      expect((yield* auth.getDescriptor()).loginMode).toBe("password");
      for (const credential of [undefined, "wrong-password", "old-pairing-token"]) {
        expect((yield* Effect.flip(auth.createBrowserSession(credential, metadata)))._tag).toBe(
          "ServerAuthInvalidCredentialError",
        );
      }
      const previous = yield* auth.createBrowserSession(password, metadata);
      const next = yield* auth.createBrowserSession(password, metadata, previous.sessionToken);
      expect((yield* sessions.verify(next.sessionToken)).subject).toBe("password");
      expect((yield* Effect.flip(sessions.verify(previous.sessionToken)))._tag).toBe(
        "SessionTokenRevokedError",
      );
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("accepts a password-protected HTTP session on a trusted remote network", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const remoteRequest = request(
        { host: "192.168.1.20:3773", origin: "http://192.168.1.20:3773" },
        {},
        "192.168.1.30",
      );
      yield* auth.assertBrowserSessionRequest(remoteRequest);
      const issued = yield* auth.createBrowserSession(password, {
        deviceType: "desktop",
        ipAddress: "192.168.1.30",
      });
      expect(issued.response.authenticated).toBe(true);
      const state = yield* auth.getSessionState(
        request(
          { host: "192.168.1.20:3773", origin: "http://192.168.1.20:3773" },
          { [sessions.cookieName]: issued.sessionToken },
          "192.168.1.30",
        ),
      );
      expect(state.authenticated).toBe(true);
      expect(state.auth.loginMode).toBe("password");
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("throttles password attempts and recovers after the failure window", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      for (let attempt = 0; attempt < 10; attempt++) {
        yield* Effect.flip(auth.createBrowserSession("wrong-password", metadata));
      }
      expect(yield* Effect.flip(auth.createBrowserSession(password, metadata))).toMatchObject({
        _tag: "ServerAuthRateLimitedError",
        retryAfterSeconds: 300,
      });
      yield* TestClock.adjust(Duration.minutes(2));
      for (const credential of ["wrong-password", password]) {
        expect(yield* Effect.flip(auth.createBrowserSession(credential, metadata))).toMatchObject({
          _tag: "ServerAuthRateLimitedError",
          retryAfterSeconds: 180,
        });
      }
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Effect.flip(auth.createBrowserSession(password, metadata))).toMatchObject({
        _tag: "ServerAuthRateLimitedError",
        retryAfterSeconds: 60,
      });
      yield* TestClock.adjust(Duration.seconds(59));
      expect(yield* Effect.flip(auth.createBrowserSession(password, metadata))).toMatchObject({
        _tag: "ServerAuthRateLimitedError",
        retryAfterSeconds: 1,
      });
      yield* TestClock.adjust(Duration.seconds(1));
      expect((yield* auth.createBrowserSession(password, metadata)).response.authenticated).toBe(
        true,
      );
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("clears recorded password failures after a successful login", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      for (let attempt = 0; attempt < 9; attempt++) {
        expect(
          (yield* Effect.flip(auth.createBrowserSession("wrong-password", metadata)))._tag,
        ).toBe("ServerAuthInvalidCredentialError");
      }
      yield* auth.createBrowserSession(password, metadata);
      for (let attempt = 0; attempt < 9; attempt++) {
        expect(
          (yield* Effect.flip(auth.createBrowserSession("wrong-password", metadata)))._tag,
        ).toBe("ServerAuthInvalidCredentialError");
      }
      expect((yield* auth.createBrowserSession(password, metadata)).response.authenticated).toBe(
        true,
      );
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("restricts cookie HTTP and WebSocket requests to their own origin", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* auth.createBrowserSession(password, metadata);
      const cookies = { [sessions.cookieName]: issued.sessionToken };
      for (const headers of [
        { origin: "https://evil.example" },
        { origin: "https://evil.example", "x-forwarded-host": "evil.example" },
        { origin: "http://127.0.0.1:9999" },
      ]) {
        expect(
          (yield* Effect.flip(auth.authenticateHttpRequest(request(headers, cookies))))._tag,
        ).toBe("ServerAuthInvalidCredentialError");
        expect(
          (yield* Effect.flip(auth.authenticateWebSocketUpgrade(request(headers, cookies), "rpc")))
            ._tag,
        ).toBe("ServerAuthInvalidCredentialError");
      }
      expect(
        (yield* auth.authenticateHttpRequest(
          request({ origin: `http://127.0.0.1:${TEST_SERVER_PORT}` }, cookies),
        )).method,
      ).toBe("browser-session-cookie");
    }).pipe(Effect.provide(layerEnvironmentAuth({ authPassword: Redacted.make(password) }))),
  );

  it.effect("preserves scoped bearer clients and ignores stale legacy cookies", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* auth.issueSession({ scopes: ["orchestration:read"] });
      const input = request(
        { authorization: `Bearer ${issued.token}`, origin: "https://other.example" },
        { cox_session: "stale" },
      );
      expect((yield* auth.authenticateHttpRequest(input)).scopes).toEqual(["orchestration:read"]);
      expect((yield* auth.authenticateWebSocketUpgrade(input, "rpc")).sessionId).toBe(
        issued.sessionId,
      );
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );

  it.effect("keeps MCP tokens restricted to the MCP endpoint", () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issued = yield* auth.issueMcpClientSession({
        label: "test client",
        access: "read-only",
        client: metadata,
      });
      const input = request({ authorization: `Bearer ${issued.token}` });
      expect((yield* auth.authenticateMcpClient(input)).access).toBe("read-only");
      expect((yield* Effect.flip(auth.authenticateHttpRequest(input)))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
      expect((yield* Effect.flip(auth.authenticateWebSocketUpgrade(input, "rpc")))._tag).toBe(
        "ServerAuthInvalidCredentialError",
      );
    }).pipe(Effect.provide(layerEnvironmentAuth())),
  );
});
