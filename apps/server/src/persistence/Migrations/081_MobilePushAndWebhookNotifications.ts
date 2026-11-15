import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE mobile_push_subscriptions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES auth_sessions(session_id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      endpoint_origin TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth_secret TEXT NOT NULL,
      label TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL,
      last_delivered_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX idx_mobile_push_subscriptions_session
    ON mobile_push_subscriptions(session_id)
  `;

  yield* sql`
    CREATE TABLE mobile_notification_dedupe (
      dedupe_key TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX idx_mobile_notification_dedupe_created_at
    ON mobile_notification_dedupe(created_at)
  `;
});
