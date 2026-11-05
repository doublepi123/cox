import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  AuthEnvironmentScopes,
  AuthEnvironmentScope,
  authScopeRequiredResponse,
  AuthGrantScopes,
  AuthStandardClientScopes,
  authScopeResponse,
  AuthSessionState,
  AuthBrowserSessionRequest,
  AuthMcpApprovalDecision,
  AuthAccessSnapshot,
  AuthAccessStreamEvent,
  ServerAuthDescriptor,
  sessionGrantsScope,
} from "./auth.ts";
import { EnvironmentHttpApi } from "./environmentHttp.ts";

describe("authorization grants", () => {
  it("removes pairing and bootstrap-token routes while retaining MCP OAuth", () => {
    expect(Object.keys(EnvironmentHttpApi.groups.auth.endpoints).sort()).toEqual([
      "browserSession",
      "revokeClient",
      "revokeOtherClients",
      "session",
      "webSocketTicket",
      "webSocketTicketFor",
    ]);
    expect(EnvironmentHttpApi.groups.mcpOAuth.endpoints.token.path).toBe("/oauth/mcp/token");
  });

  it("requires an explicit local or password login mode", () => {
    const decode = Schema.decodeUnknownSync(ServerAuthDescriptor);
    const descriptor = {
      policy: "loopback-browser",
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "cox_session",
    };
    expect(decode({ ...descriptor, loginMode: "local" }).loginMode).toBe("local");
    expect(decode({ ...descriptor, loginMode: "password" }).loginMode).toBe("password");
    expect(() => decode(descriptor)).toThrow();
    expect(() => decode({ ...descriptor, loginMode: "pairing" })).toThrow();
  });

  it("accepts empty local session requests and trims supplied passwords", () => {
    const decode = Schema.decodeUnknownSync(AuthBrowserSessionRequest);
    expect(decode({})).toEqual({});
    expect(decode({ credential: "  password  " })).toEqual({ credential: "password" });
    expect(() => decode({ credential: "  " })).toThrow();
    expect(() => decode({ credential: null })).toThrow();
  });

  it("restricts MCP approval to browser sessions or denial", () => {
    const decode = Schema.decodeUnknownSync(AuthMcpApprovalDecision);
    expect(decode({ _tag: "deny" })).toEqual({ _tag: "deny" });
    expect(decode({ _tag: "browser-session", access: "read-only", csrfToken: "csrf" })).toEqual({
      _tag: "browser-session",
      access: "read-only",
      csrfToken: "csrf",
    });
    expect(() => decode({ _tag: "pairing-code", access: "read-only", code: "secret" })).toThrow();
  });

  it("keeps access snapshots and events limited to clients", () => {
    expect(Schema.decodeSync(AuthAccessSnapshot)({ clientSessions: [] })).toEqual({
      clientSessions: [],
    });
    const decode = Schema.decodeUnknownSync(AuthAccessStreamEvent);
    expect(
      decode({ version: 1, revision: 0, type: "snapshot", payload: { clientSessions: [] } }).type,
    ).toBe("snapshot");
    for (const type of ["pairingLinkUpserted", "pairingLinkRemoved"]) {
      expect(() => decode({ version: 1, revision: 0, type, payload: { id: "old" } })).toThrow();
    }
  });

  it("decodes legacy review credentials without offering them in new grants", () => {
    const decodeAuthEnvironmentScopes = Schema.decodeSync(AuthEnvironmentScopes);

    expect(decodeAuthEnvironmentScopes(["review:write"])).toEqual(["review:write"]);
    const decodeAuthGrantScopes = Schema.decodeUnknownSync(AuthGrantScopes);

    expect(() => decodeAuthGrantScopes(["review:write"])).toThrow();
    expect(AuthStandardClientScopes).not.toContain("review:write");
  });

  // Keep the pre-granular vocabulary frozen to expose compatibility regressions.
  const oldScopes = Schema.Array(
    Schema.Literals([
      "orchestration:read",
      "orchestration:operate",
      "terminal:operate",
      "review:write",
      "access:read",
      "access:write",
      "relay:read",
      "relay:write",
    ]),
  );

  const decodeOldScopes = Schema.decodeUnknownSync(oldScopes);

  it.each(AuthEnvironmentScope.literals)(
    "keeps %s permission errors decodable by old clients",
    (scope) => {
      const response = authScopeRequiredResponse(scope);
      expect(decodeOldScopes([response.requiredScope])).toEqual([response.requiredScope]);
      expect(response.requiredPermission).toBe(scope);
    },
  );

  it("keeps old clients able to decode grants with new permissions", () => {
    const response = authScopeResponse(AuthStandardClientScopes);
    expect(decodeOldScopes(response.scopes)).toEqual(response.scopes);
    expect(response.permissions).toEqual(AuthStandardClientScopes);
    expect(response.scopes).not.toContain("filesystem:read");
  });

  it("ignores unknown response permissions without falling back to broader scopes", () => {
    const decodeAuthSessionState = Schema.decodeUnknownSync(AuthSessionState);

    const session = decodeAuthSessionState({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        loginMode: "local",
        sessionMethods: [],
        sessionCookieName: "session",
      },
      scopes: ["orchestration:operate"],
      permissions: ["future:permission"],
    });
    expect(session.permissions).toEqual([]);
    expect(sessionGrantsScope(session, "orchestration:operate")).toBe(false);
    expect(sessionGrantsScope(session, "settings:write")).toBe(false);
  });

  it.each([
    {
      label: "exact permissions over the legacy presentation",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        permissions: ["filesystem:read"],
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "a permission absent from the legacy presentation",
      session: { authenticated: true, scopes: [], permissions: ["filesystem:read"] },
      scope: "filesystem:read",
      expected: true,
    },

    {
      label: "the parent on a server that predates the split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "only the exact scope on a server that knows the split",
      session: {
        authenticated: true,
        scopes: ["orchestration:operate"],
        auth: { serverUpdateScope: "environment:maintain" },
      },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "the exact scope regardless of server version",
      session: { authenticated: true, scopes: ["settings:write"], auth: {} },
      scope: "settings:write",
      expected: true,
    },
    {
      label: "nothing for an unauthenticated session",
      session: { authenticated: false, scopes: ["orchestration:operate"], auth: {} },
      scope: "settings:write",
      expected: false,
    },
    {
      label: "no parent for scopes that were never split",
      session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
      scope: "access:write",
      expected: false,
    },
  ] as const)("sessionGrantsScope accepts $label", ({ session, scope, expected }) => {
    expect(sessionGrantsScope(session, scope)).toBe(expected);
  });
});
