import type { AuthClientMetadata, AuthClientSession } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { IssuedBearerSession } from "./auth/EnvironmentAuth.ts";

const newline = "\n";

function serializeOptionalFields(values: ReadonlyArray<string | null | undefined>) {
  return values.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function formatClientMetadata(metadata: AuthClientMetadata): string {
  const details = serializeOptionalFields([
    metadata.label,
    metadata.deviceType !== "unknown" ? metadata.deviceType : undefined,
    metadata.os,
    metadata.browser,
    metadata.ipAddress,
  ]);
  return details.length > 0 ? details.join(" | ") : "unlabeled client";
}

function toIsoString(value: DateTime.DateTime | DateTime.Utc): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

export function formatIssuedSession(
  session: IssuedBearerSession,
  options?: {
    readonly json?: boolean;
    readonly tokenOnly?: boolean;
  },
): string {
  if (options?.tokenOnly) {
    return `${session.token}${newline}`;
  }

  if (options?.json) {
    return `${JSON.stringify(
      {
        sessionId: session.sessionId,
        token: session.token,
        method: session.method,
        scopes: session.scopes,
        subject: session.subject,
        client: session.client,
        expiresAt: toIsoString(session.expiresAt),
      },
      null,
      2,
    )}${newline}`;
  }

  return (
    [
      `Issued bearer access token ${session.sessionId}.`,
      `Scopes: ${session.scopes.join(" ")}`,
      `Token: ${session.token}`,
      `Subject: ${session.subject}`,
      `Client: ${formatClientMetadata(session.client)}`,
      `Expires at: ${toIsoString(session.expiresAt)}`,
    ].join(newline) + newline
  );
}

export function formatSessionList(
  sessions: ReadonlyArray<AuthClientSession>,
  options?: {
    readonly json?: boolean;
  },
): string {
  if (options?.json) {
    return `${JSON.stringify(
      sessions.map((session) => ({
        sessionId: session.sessionId,
        method: session.method,
        scopes: session.scopes,
        subject: session.subject,
        client: session.client,
        connected: session.connected,
        issuedAt: toIsoString(session.issuedAt),
        expiresAt: toIsoString(session.expiresAt),
        lastConnectedAt: session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : null,
      })),
      null,
      2,
    )}${newline}`;
  }

  if (sessions.length === 0) {
    return `No active sessions.${newline}`;
  }

  return (
    sessions
      .map((session) =>
        [
          `${session.sessionId}${session.connected ? " connected" : ""}`,
          `  scopes: ${session.scopes.join(" ")}`,
          `  method: ${session.method}`,
          `  subject: ${session.subject}`,
          `  client: ${formatClientMetadata(session.client)}`,
          `  issued: ${toIsoString(session.issuedAt)}`,
          `  last connected: ${
            session.lastConnectedAt ? toIsoString(session.lastConnectedAt) : "never"
          }`,
          `  expires: ${toIsoString(session.expiresAt)}`,
        ].join(newline),
      )
      .join(`${newline}${newline}`) + newline
  );
}
