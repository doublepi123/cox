import { AuthSessionId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import { commit, now, run, thread } from "./AgentAttentionNotifier.testkit.ts";
import { keys } from "./notificationReceiver.testkit.ts";

export const initialize = (pushEndpoint: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
    VALUES ('session', 'owner', '[]', 'browser-session-cookie', '2026-11-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', NULL)`;
    const subscriptions = yield* NotificationSubscriptionRepository;
    for (const suffix of ["/push", "/gone"]) {
      yield* subscriptions.upsertSubscription({
        sessionId: AuthSessionId.make("session"),
        endpoint: `${pushEndpoint}${suffix}`,
        endpointOrigin: pushEndpoint,
        keys,
        label: suffix,
        userAgent: null,
        createdAt: DateTime.formatIso(now),
      });
    }
    yield* (yield* ServerSecretStore).set(
      "notifications.webhook.aG9vaw.secret",
      new TextEncoder().encode("vault-secret"),
    );
    yield* commit({ type: "thread.created", payload: thread });
    yield* commit({ type: "run.created", payload: run("run-1") });
  });
