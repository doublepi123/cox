import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE agent_feedback (
    id TEXT PRIMARY KEY, thread_id TEXT, created_at TEXT NOT NULL,
    kind TEXT NOT NULL, subject TEXT NOT NULL, expected TEXT NOT NULL,
    actual TEXT NOT NULL, workaround TEXT NOT NULL
  )`;
});
