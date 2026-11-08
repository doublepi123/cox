import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthStandardClientScopes,
  type AuthBrowserSessionResult,
  type AuthClientMetadata,
  type AuthClientSession,
  type AuthEnvironmentScope,
  type AuthMcpClientAccess,
  type AuthSessionId,
  type AuthSessionState,
  authScopeResponse,
  type ServerAuthDescriptor,
  type ServerAuthSessionMethod,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
  DpopFailureReason,
  type DpopFailureReason as DpopFailureReasonType,
  mcpClientScopes,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

import { deriveAuthClientMetadata, isLoopbackAddress } from "./utils.ts";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";
import { resolvePasswordAuth } from "./PasswordAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as SessionStore from "./SessionStore.ts";
import { verifyRequestDpopProof } from "./dpop.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";

const DEFAULT_SESSION_SUBJECT = "cli-issued-session";

export interface IssuedBearerSession {
  readonly sessionId: AuthSessionId;
  readonly token: string;
  readonly method: "bearer-access-token";
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly client: AuthClientMetadata;
  readonly expiresAt: DateTime.Utc;
}

// MCP client tokens are restricted to /mcp; HTTP API and WebSocket RPC would bypass their access cap.
const MCP_CLIENT_SUBJECT = "mcp-client";
const MCP_CLIENT_SESSION_TTL = Duration.days(30);

export interface McpClientSession {
  readonly sessionId: AuthSessionId;
  readonly label: string;
  readonly access: AuthMcpClientAccess;
}

export interface AuthenticatedSession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly proofKeyThumbprint?: string;
  readonly expiresAt?: DateTime.DateTime;
}

const serverAuthInternalErrorContext = {
  cause: Schema.Defect(),
};

export class ServerAuthSessionCredentialValidationError extends Schema.TaggedError<ServerAuthSessionCredentialValidationError>()(
  "ServerAuthSessionCredentialValidationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to validate session credential.";
  }
}

export class ServerAuthAuthenticatedSessionIssueError extends Schema.TaggedError<ServerAuthAuthenticatedSessionIssueError>()(
  "ServerAuthAuthenticatedSessionIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue authenticated session.";
  }
}

export class ServerAuthSessionTokenIssueError extends Schema.TaggedError<ServerAuthSessionTokenIssueError>()(
  "ServerAuthSessionTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue session token.";
  }
}

export class ServerAuthSessionsListError extends Schema.TaggedError<ServerAuthSessionsListError>()(
  "ServerAuthSessionsListError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to list sessions.";
  }
}

export class ServerAuthSessionRevocationError extends Schema.TaggedError<ServerAuthSessionRevocationError>()(
  "ServerAuthSessionRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke session.";
  }
}

export class ServerAuthOtherSessionsRevocationError extends Schema.TaggedError<ServerAuthOtherSessionsRevocationError>()(
  "ServerAuthOtherSessionsRevocationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to revoke other sessions.";
  }
}

export class ServerAuthWebSocketTokenIssueError extends Schema.TaggedError<ServerAuthWebSocketTokenIssueError>()(
  "ServerAuthWebSocketTokenIssueError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to issue websocket token.";
  }
}

export class ServerAuthDpopReplayStateRecordError extends Schema.TaggedError<ServerAuthDpopReplayStateRecordError>()(
  "ServerAuthDpopReplayStateRecordError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to record DPoP proof replay state.";
  }
}

export class ServerAuthDpopReplayKeyCalculationError extends Schema.TaggedError<ServerAuthDpopReplayKeyCalculationError>()(
  "ServerAuthDpopReplayKeyCalculationError",
  {
    ...serverAuthInternalErrorContext,
  },
) {
  override get message(): string {
    return "Failed to calculate DPoP replay key.";
  }
}

export const ServerAuthInternalError = Schema.Union([
  ServerAuthSessionCredentialValidationError,
  ServerAuthAuthenticatedSessionIssueError,
  ServerAuthSessionTokenIssueError,
  ServerAuthSessionsListError,
  ServerAuthSessionRevocationError,
  ServerAuthOtherSessionsRevocationError,
  ServerAuthWebSocketTokenIssueError,
  ServerAuthDpopReplayStateRecordError,
  ServerAuthDpopReplayKeyCalculationError,
]);
export type ServerAuthInternalError = typeof ServerAuthInternalError.Type;
export const isServerAuthInternalError = Schema.is(ServerAuthInternalError);

export class ServerAuthMissingCredentialError extends Schema.TaggedError<ServerAuthMissingCredentialError>()(
  "ServerAuthMissingCredentialError",
  {},
) {
  override get message(): string {
    return "Server authentication credential is missing.";
  }
}

export class ServerAuthInvalidCredentialError extends Schema.TaggedError<ServerAuthInvalidCredentialError>()(
  "ServerAuthInvalidCredentialError",
  {
    diagnostic: Schema.optional(Schema.String),
    dpopFailureReason: Schema.optionalKey(DpopFailureReason),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Server authentication credential is invalid.";
  }
}

export const ServerAuthCredentialError = Schema.Union([
  ServerAuthMissingCredentialError,
  ServerAuthInvalidCredentialError,
]);
export type ServerAuthCredentialError = typeof ServerAuthCredentialError.Type;
export const isServerAuthCredentialError = Schema.is(ServerAuthCredentialError);
export const serverAuthCredentialReason = (
  error: ServerAuthCredentialError,
): "missing_credential" | "invalid_credential" =>
  error._tag === "ServerAuthMissingCredentialError" ? "missing_credential" : "invalid_credential";

export const serverAuthDpopFailureReason = (
  error: ServerAuthCredentialError,
): DpopFailureReasonType | undefined =>
  error._tag === "ServerAuthInvalidCredentialError" ? error.dpopFailureReason : undefined;

export class ServerAuthForbiddenOperationError extends Schema.TaggedError<ServerAuthForbiddenOperationError>()(
  "ServerAuthForbiddenOperationError",
  {},
) {
  override get message(): string {
    return "The current authentication session cannot revoke itself.";
  }
}

export class EnvironmentAuth extends Context.Service<
  EnvironmentAuth,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
    readonly getSessionState: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthSessionState, ServerAuthInternalError>;
    readonly assertBrowserSessionRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<void, ServerAuthInvalidCredentialError>;
    readonly createBrowserSession: (
      credential: string | undefined,
      requestMetadata: AuthClientMetadata,
      previousSessionToken?: string,
    ) => Effect.Effect<
      {
        readonly response: AuthBrowserSessionResult;
        readonly sessionToken: string;
        readonly cookieName?: string;
        readonly expireNormalCookie?: boolean;
      },
      ServerAuthInvalidCredentialError | ServerAuthInternalError
    >;
    readonly issueSession: (input?: {
      readonly ttl?: Duration.Duration;
      readonly subject?: string;
      readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
      readonly label?: string;
    }) => Effect.Effect<IssuedBearerSession, ServerAuthInternalError>;
    readonly listSessions: () => Effect.Effect<
      ReadonlyArray<AuthClientSession>,
      ServerAuthInternalError
    >;
    readonly revokeSession: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthInternalError>;
    readonly listClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<ReadonlyArray<AuthClientSession>, ServerAuthInternalError>;
    readonly revokeClientSession: (
      currentSessionId: AuthSessionId,
      targetSessionId: AuthSessionId,
    ) => Effect.Effect<boolean, ServerAuthForbiddenOperationError | ServerAuthInternalError>;
    readonly revokeOtherClientSessions: (
      currentSessionId: AuthSessionId,
    ) => Effect.Effect<number, ServerAuthInternalError>;
    readonly authenticateHttpRequest: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly authenticateWebSocketUpgrade: (
      request: HttpServerRequest.HttpServerRequest,
      use: AuthWebSocketTicketUse,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueWebSocketTicket: (
      session: Pick<AuthenticatedSession, "sessionId" | "proofKeyThumbprint">,
      input?: { readonly use?: AuthWebSocketTicketUse },
    ) => Effect.Effect<AuthWebSocketTicketResult, ServerAuthInternalError>;
    readonly authenticateMcpClient: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpClientSession, ServerAuthCredentialError | ServerAuthInternalError>;
    readonly issueMcpClientSession: (input: {
      readonly label: string;
      readonly access: AuthMcpClientAccess;
      readonly client: AuthClientMetadata;
    }) => Effect.Effect<
      {
        readonly sessionId: AuthSessionId;
        readonly token: string;
        readonly expiresAt: DateTime.DateTime;
      },
      ServerAuthInternalError
    >;
    readonly authenticateBrowserSession: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError>;
  }
>()("cox/auth/EnvironmentAuth") {}

const AUTHORIZATION_PREFIX = "Bearer ";
const DPOP_AUTHORIZATION_PREFIX = "DPoP ";
const WebSocketUpgradeQuery = Schema.Struct({
  wsTicket: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
  dpop: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)),
});
const decodeWebSocketUpgradeQuery = Schema.decodeEffect(WebSocketUpgradeQuery);

const bySessionPriority = (left: AuthClientSession, right: AuthClientSession) => {
  const leftCanManage = left.scopes.includes(AuthAccessWriteScope);
  const rightCanManage = right.scopes.includes(AuthAccessWriteScope);
  if (leftCanManage !== rightCanManage) {
    return leftCanManage ? -1 : 1;
  }
  if (left.connected !== right.connected) {
    return left.connected ? -1 : 1;
  }
  return right.issuedAt.epochMilliseconds - left.issuedAt.epochMilliseconds;
};

const rejectMcpClientAudience = <S extends { readonly subject: string }>(session: S) =>
  session.subject === MCP_CLIENT_SUBJECT
    ? Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "MCP client sessions are only accepted by the MCP endpoint.",
        }),
      ).pipe(Effect.tap(() => Effect.logWarning("Rejected an MCP client session outside /mcp.")))
    : Effect.succeed(session);

const mapSessionVerificationErrors = <A, R>(
  effect: Effect.Effect<A, SessionStore.SessionCredentialError, R>,
): Effect.Effect<A, ServerAuthInvalidCredentialError | ServerAuthInternalError, R> =>
  effect.pipe(
    Effect.mapError((cause) =>
      SessionStore.isSessionCredentialInvalidError(cause)
        ? new ServerAuthInvalidCredentialError({ cause })
        : new ServerAuthSessionCredentialValidationError({ cause }),
    ),
  );

function parseBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^Bearer /i.test(header)) {
    return null;
  }
  const token = header.slice(AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function parseDpopToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const header = request.headers["authorization"];
  if (typeof header !== "string" || !/^DPoP /i.test(header)) {
    return null;
  }
  const token = header.slice(DPOP_AUTHORIZATION_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

export function selectRequestCredential(
  request: HttpServerRequest.HttpServerRequest,
  cookieName: string,
  legacyCookieName: string | undefined,
) {
  const cookieToken = request.cookies[cookieName];
  if (cookieToken !== undefined) {
    return { token: cookieToken, source: "cookie" } as const;
  }

  const bearerToken = parseBearerToken(request);
  if (bearerToken !== null) {
    return { token: bearerToken, source: "bearer" } as const;
  }

  const dpopToken = parseDpopToken(request);
  if (dpopToken !== null) {
    return { token: dpopToken, source: "dpop" } as const;
  }

  const legacyToken = legacyCookieName ? request.cookies[legacyCookieName] : undefined;
  if (legacyToken !== undefined) {
    return { token: legacyToken, source: "legacy-cookie" } as const;
  }

  return undefined;
}

type RequestCredentialSource = NonNullable<ReturnType<typeof selectRequestCredential>>["source"];

export const isBrowserCookieCredential = (source: RequestCredentialSource) =>
  source === "cookie" || source === "legacy-cookie";

function requestHost(request: HttpServerRequest.HttpServerRequest): URL | undefined {
  const host = request.headers.host;
  if (!host || /[\s,/@?#\\]/u.test(host)) return undefined;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.pathname === "/" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  if (request.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (trustedOrigins.has(origin)) return true;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) && parsed.host === requestHost(request)?.host
    );
  } catch {
    return false;
  }
}

/** @public */
export const make = Effect.gen(function* () {
  const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
  const sessions = yield* SessionStore.SessionStore;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const descriptor = yield* policy.getDescriptor();
  const config = yield* ServerConfig.ServerConfig;
  const passwordAuth = yield* resolvePasswordAuth(config);

  const authenticateToken = (
    token: string,
  ): Effect.Effect<
    AuthenticatedSession,
    ServerAuthInvalidCredentialError | ServerAuthInternalError
  > =>
    sessions.verify(token).pipe(
      Effect.tapError((cause) =>
        SessionStore.isSessionCredentialInvalidError(cause)
          ? Effect.logWarning("Rejected authenticated session credential.").pipe(
              Effect.annotateLogs({
                reason: cause.message,
              }),
            )
          : Effect.void,
      ),
      mapSessionVerificationErrors,
      Effect.flatMap(rejectMcpClientAudience),
      Effect.map((session) => ({
        sessionId: session.sessionId,
        subject: session.subject,
        method: session.method,
        scopes: session.scopes,
        ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
        ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
      })),
    );

  const resolveRequestCredential = (request: HttpServerRequest.HttpServerRequest) =>
    selectRequestCredential(request, sessions.cookieName, sessions.legacyCookieName);

  // Cookies span ports; reject cookie-authenticated requests and sockets from other same-site origins.
  const trustedBrowserOrigins = new Set<string>([
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...config.devAllowedOrigins,
  ]);

  const authenticateRequest = (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.Effect<AuthenticatedSession, ServerAuthCredentialError | ServerAuthInternalError> => {
    const dpopToken = parseDpopToken(request);
    const credential = resolveRequestCredential(request);
    if (!credential?.token) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    if (
      isBrowserCookieCredential(credential.source) &&
      !isBrowserOriginAllowed(request, trustedBrowserOrigins)
    ) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sessions are only accepted from the app's own origin.",
        }),
      );
    }
    return (
      isBrowserCookieCredential(credential.source) && descriptor.loginMode === "local"
        ? assertBrowserSessionRequest(request)
        : Effect.void
    ).pipe(
      Effect.andThen(authenticateToken(credential.token)),
      Effect.flatMap((session) => {
        if (session.proofKeyThumbprint) {
          if (!dpopToken || dpopToken !== credential.token) {
            return Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound access token requires DPoP authorization.",
                dpopFailureReason: "invalid_proof",
              }),
            );
          }
          return verifyRequestDpopProof({
            request,
            expectedThumbprint: session.proofKeyThumbprint,
            expectedAccessToken: dpopToken,
          }).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.as(session),
          );
        }
        if (dpopToken) {
          return Effect.fail(
            new ServerAuthInvalidCredentialError({
              diagnostic: "DPoP authorization requires a proof-bound access token.",
              dpopFailureReason: "invalid_proof",
            }),
          );
        }
        return Effect.succeed(session);
      }),
    );
  };

  const getSessionState: EnvironmentAuth["Service"]["getSessionState"] = (request) =>
    authenticateRequest(request).pipe(
      Effect.map(
        (session) =>
          ({
            authenticated: true,
            auth: descriptor,
            ...authScopeResponse(session.scopes),
            sessionMethod: session.method,
            ...(session.expiresAt ? { expiresAt: DateTime.toUtc(session.expiresAt) } : {}),
          }) satisfies AuthSessionState,
      ),
      Effect.catchIf(isServerAuthCredentialError, () =>
        Effect.succeed({
          authenticated: false,
          auth: descriptor,
        } satisfies AuthSessionState),
      ),
      Effect.withSpan("EnvironmentAuth.getSessionState"),
    );

  const assertBrowserSessionRequest: EnvironmentAuth["Service"]["assertBrowserSessionRequest"] = (
    request,
  ) => {
    if (!isBrowserOriginAllowed(request, trustedBrowserOrigins)) {
      return Effect.fail(
        new ServerAuthInvalidCredentialError({
          diagnostic: "Browser sign-in requires the app's own origin.",
        }),
      );
    }
    if (descriptor.loginMode === "local") {
      const hostname = requestHost(request)?.hostname.replace(/^\[|\]$/g, "");
      const peer = deriveAuthClientMetadata({ request }).ipAddress;
      if (
        !hostname ||
        !isLoopbackAddress(hostname) ||
        !peer ||
        !isLoopbackAddress(peer) ||
        request.headers["x-forwarded-host"] !== undefined ||
        request.headers["x-forwarded-for"] !== undefined ||
        request.headers.forwarded !== undefined
      ) {
        return Effect.fail(
          new ServerAuthInvalidCredentialError({
            diagnostic: "Passwordless sign-in is only available directly on loopback.",
          }),
        );
      }
    }
    return Effect.void;
  };

  const createBrowserSession: EnvironmentAuth["Service"]["createBrowserSession"] = Effect.fn(
    "EnvironmentAuth.createBrowserSession",
  )(function* (credential, requestMetadata, previousSessionToken) {
    if (passwordAuth !== undefined) {
      if (credential === undefined || !(yield* passwordAuth.matches(credential))) {
        yield* passwordAuth.recordFailure;
        return yield* new ServerAuthInvalidCredentialError({});
      }
    } else if (credential !== undefined) {
      return yield* new ServerAuthInvalidCredentialError({});
    }
    const previousSession =
      previousSessionToken === undefined
        ? undefined
        : yield* sessions.verify(previousSessionToken).pipe(
            Effect.catchIf(SessionStore.isSessionCredentialInvalidError, () => Effect.void),
            Effect.mapError((cause) => new ServerAuthSessionCredentialValidationError({ cause })),
          );
    const session = yield* sessions
      .issue({
        method: "browser-session-cookie",
        subject: descriptor.loginMode,
        scopes: AuthStandardClientScopes,
        ...(previousSession?.method === "browser-session-cookie"
          ? { replaceSessionId: previousSession.sessionId }
          : {}),
        client: { ...requestMetadata, label: passwordAuth ? "Password login" : "Local browser" },
      })
      .pipe(Effect.mapError((cause) => new ServerAuthAuthenticatedSessionIssueError({ cause })));
    return {
      response: {
        authenticated: true,
        ...authScopeResponse(session.scopes),
        sessionMethod: session.method,
        expiresAt: DateTime.toUtc(session.expiresAt),
      },
      sessionToken: session.token,
    };
  });

  const issueSession: EnvironmentAuth["Service"]["issueSession"] = (input) =>
    sessions
      .issue({
        subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
        method: "bearer-access-token",
        scopes: input?.scopes ?? AuthStandardClientScopes,
        client: {
          ...(input?.label ? { label: input.label } : {}),
          deviceType: "bot",
        },
        ...(input?.ttl ? { ttl: input.ttl } : {}),
      })
      .pipe(
        Effect.map(
          (issued) =>
            ({
              sessionId: issued.sessionId,
              token: issued.token,
              method: "bearer-access-token",
              scopes: issued.scopes,
              subject: input?.subject ?? DEFAULT_SESSION_SUBJECT,
              client: issued.client,
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies IssuedBearerSession,
        ),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueSession"),
      );

  const listSessions: EnvironmentAuth["Service"]["listSessions"] = () =>
    sessions.listActive().pipe(
      Effect.map((activeSessions) => activeSessions.toSorted(bySessionPriority)),
      Effect.mapError((cause) => new ServerAuthSessionsListError({ cause })),
      Effect.withSpan("EnvironmentAuth.listSessions"),
    );

  const revokeSession: EnvironmentAuth["Service"]["revokeSession"] = (sessionId) =>
    sessions.revoke(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthSessionRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeSession"),
    );

  const revokeOtherSessionsExcept = (sessionId: AuthSessionId) =>
    sessions.revokeAllExcept(sessionId).pipe(
      Effect.mapError((cause) => new ServerAuthOtherSessionsRevocationError({ cause })),
      Effect.withSpan("EnvironmentAuth.revokeOtherSessionsExcept"),
    );

  const listClientSessions: EnvironmentAuth["Service"]["listClientSessions"] = (currentSessionId) =>
    listSessions().pipe(
      Effect.map((clientSessions) =>
        clientSessions.map((clientSession): AuthClientSession => ({
          ...clientSession,
          ...authScopeResponse(clientSession.scopes),
          current: clientSession.sessionId === currentSessionId,
        })),
      ),
      Effect.withSpan("EnvironmentAuth.listClientSessions"),
    );

  const revokeClientSession: EnvironmentAuth["Service"]["revokeClientSession"] = Effect.fn(
    "EnvironmentAuth.revokeClientSession",
  )(function* (currentSessionId, targetSessionId) {
    if (currentSessionId === targetSessionId) {
      return yield* new ServerAuthForbiddenOperationError({});
    }
    return yield* revokeSession(targetSessionId);
  });

  const revokeOtherClientSessions: EnvironmentAuth["Service"]["revokeOtherClientSessions"] = (
    currentSessionId,
  ) =>
    revokeOtherSessionsExcept(currentSessionId).pipe(
      Effect.withSpan("EnvironmentAuth.revokeOtherClientSessions"),
    );

  // Only the RPC socket's ticket is bound to the client's proof key. The media
  // routes reuse one ticket across <img>, EventSource and several sockets, and
  // each of those would need its own single-use proof.
  const issueWebSocketTicket: EnvironmentAuth["Service"]["issueWebSocketTicket"] = (
    session,
    input,
  ) =>
    sessions
      .issueWebSocketToken(session.sessionId, {
        ...(input?.use ? { audience: input.use } : {}),
        ...(input?.use === "rpc" && session.proofKeyThumbprint
          ? { proofKeyThumbprint: session.proofKeyThumbprint }
          : {}),
      })
      .pipe(
        Effect.mapError((cause) => new ServerAuthWebSocketTokenIssueError({ cause })),
        Effect.map(
          (issued) =>
            ({
              ticket: Redacted.make(issued.token),
              expiresAt: DateTime.toUtc(issued.expiresAt),
            }) satisfies AuthWebSocketTicketResult,
        ),
        Effect.withSpan("EnvironmentAuth.issueWebSocketTicket"),
      );

  const authenticateHttpRequest: EnvironmentAuth["Service"]["authenticateHttpRequest"] = (
    request,
  ) =>
    authenticateRequest(request).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest"));

  const authenticateWebSocketUpgrade: EnvironmentAuth["Service"]["authenticateWebSocketUpgrade"] =
    Effect.fn("EnvironmentAuth.authenticateWebSocketUpgrade")(function* (request, use) {
      const requestUrl = HttpServerRequest.toURL(request);
      if (Option.isSome(requestUrl)) {
        const query = yield* decodeWebSocketUpgradeQuery(
          Object.fromEntries(requestUrl.value.searchParams),
        ).pipe(Effect.orDie);
        const websocketTicket = query.wsTicket && Redacted.value(query.wsTicket);
        if (websocketTicket && websocketTicket.trim().length > 0) {
          const session = yield* sessions
            .verifyWebSocketToken(websocketTicket)
            .pipe(mapSessionVerificationErrors, Effect.flatMap(rejectMcpClientAudience));
          if (session.audience !== undefined && session.audience !== use) {
            return yield* new ServerAuthInvalidCredentialError({
              diagnostic: `WebSocket ticket was issued for the ${session.audience} route.`,
            });
          }
          if (session.proofKeyThumbprint) {
            // WebSocket clients cannot set headers, so the proof travels in the query.
            // The proof hashes the ticket; consuming its jti prevents replay after first use.
            // Only encrypted transport prevents an active interceptor from racing that use.
            const proof = request.headers.dpop ?? (query.dpop && Redacted.value(query.dpop));
            if (!proof) {
              return yield* new ServerAuthInvalidCredentialError({
                diagnostic: "DPoP-bound WebSocket ticket requires a DPoP proof.",
                dpopFailureReason: "invalid_proof",
              });
            }
            yield* verifyRequestDpopProof({
              request,
              proof,
              expectedThumbprint: session.proofKeyThumbprint,
              expectedAccessToken: websocketTicket,
            }).pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
              Effect.provideService(Crypto.Crypto, crypto),
            );
          }
          return {
            sessionId: session.sessionId,
            subject: session.subject,
            method: session.method,
            scopes: session.scopes,
            ...(session.proofKeyThumbprint
              ? { proofKeyThumbprint: session.proofKeyThumbprint }
              : {}),
            ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
          };
        }
      }

      return yield* authenticateRequest(request);
    });

  const authenticateMcpClient: EnvironmentAuth["Service"]["authenticateMcpClient"] = (request) => {
    const token = parseBearerToken(request);
    if (token === null) return Effect.fail(new ServerAuthMissingCredentialError({}));
    return sessions.verify(token).pipe(
      mapSessionVerificationErrors,
      Effect.flatMap((session) =>
        session.subject === MCP_CLIENT_SUBJECT && session.method === "bearer-access-token"
          ? Effect.succeed({
              sessionId: session.sessionId,
              label: session.client.label ?? "MCP client",
              access: session.scopes.includes(AuthOrchestrationOperateScope)
                ? (session.runtimeModeCeiling ?? "approval-required")
                : "read-only",
            } satisfies McpClientSession)
          : Effect.fail(
              new ServerAuthInvalidCredentialError({
                diagnostic: "Only MCP client sessions are accepted here.",
              }),
            ),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateMcpClient"),
    );
  };

  const issueMcpClientSession: EnvironmentAuth["Service"]["issueMcpClientSession"] = (input) =>
    sessions
      .issue({
        subject: MCP_CLIENT_SUBJECT,
        method: "bearer-access-token",
        scopes: mcpClientScopes(input.access),
        ttl: MCP_CLIENT_SESSION_TTL,
        ...(input.access === "read-only" ? {} : { runtimeModeCeiling: input.access }),
        client: { ...input.client, label: input.label, deviceType: "bot" },
      })
      .pipe(
        Effect.map((issued) => ({
          sessionId: issued.sessionId,
          token: issued.token,
          expiresAt: issued.expiresAt,
        })),
        Effect.mapError((cause) => new ServerAuthSessionTokenIssueError({ cause })),
        Effect.withSpan("EnvironmentAuth.issueMcpClientSession"),
      );

  const authenticateBrowserSession: EnvironmentAuth["Service"]["authenticateBrowserSession"] = (
    request,
  ) => {
    const credential = resolveRequestCredential(request);
    if (!credential || !isBrowserCookieCredential(credential.source)) {
      return Effect.fail(new ServerAuthMissingCredentialError({}));
    }
    return authenticateRequest(request).pipe(
      Effect.filterOrFail(
        (session) => session.method === "browser-session-cookie",
        () => new ServerAuthInvalidCredentialError({ diagnostic: "Not a browser session." }),
      ),
      Effect.withSpan("EnvironmentAuth.authenticateBrowserSession"),
    );
  };

  return EnvironmentAuth.of({
    getDescriptor: Effect.fn("EnvironmentAuth.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
    getSessionState,
    assertBrowserSessionRequest,
    createBrowserSession,
    issueSession,
    listSessions,
    revokeSession,
    listClientSessions,
    revokeClientSession,
    revokeOtherClientSessions,
    authenticateHttpRequest,
    authenticateWebSocketUpgrade,
    issueWebSocketTicket,
    authenticateMcpClient,
    issueMcpClientSession,
    authenticateBrowserSession,
  });
});

export const layer = Layer.effect(EnvironmentAuth, make).pipe(
  Layer.provideMerge(SessionStore.layer),
  Layer.provideMerge(EnvironmentAuthPolicy.layer),
);

const layerStorage = Layer.mergeAll(ServerSecretStore.layer, SqlitePersistence.layerConfig);

export const layerRuntime = layer.pipe(
  Layer.provideMerge(layerStorage),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
);
