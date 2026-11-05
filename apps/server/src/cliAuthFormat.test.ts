import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatIssuedSession, formatSessionList } from "./cliAuthFormat.ts";
import type { IssuedBearerSession } from "./auth/EnvironmentAuth.ts";

const issued: IssuedBearerSession = {
  sessionId: AuthSessionId.make("cli-session"),
  token: "cli-bearer-secret",
  method: "bearer-access-token",
  scopes: [],
  subject: "cli-client",
  client: { deviceType: "unknown" },
  expiresAt: DateTime.makeUnsafe("2026-12-01T00:00:00Z"),
};

it("preserves explicit bearer-session issuance output", () => {
  expect(formatIssuedSession(issued, { tokenOnly: true })).toBe("cli-bearer-secret\n");
  expect(JSON.parse(formatIssuedSession(issued, { json: true }))).toMatchObject({
    sessionId: "cli-session",
    token: "cli-bearer-secret",
    method: "bearer-access-token",
  });
  expect(formatIssuedSession(issued)).toContain("Issued bearer access token cli-session.");
});

it("lists sessions without revealing bearer secrets", () => {
  const session = {
    ...issued,
    issuedAt: DateTime.makeUnsafe("2026-11-05T00:00:00Z"),
    lastConnectedAt: null,
    connected: false,
    current: false,
  };
  expect(formatSessionList([session])).toContain("cli-session");
  expect(formatSessionList([session])).not.toContain(issued.token);
  expect(formatSessionList([session], { json: true })).not.toContain(issued.token);
  expect(formatSessionList([])).toBe("No active sessions.\n");
});
