import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "079_RemovePairingAuthentication",
  (it) => {
    it.effect(
      "removes pairing credentials and revokes existing sessions without deleting unrelated data",
      () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 78 });
          yield* sql`CREATE TABLE preserved_auth_migration_data (value TEXT NOT NULL)`;
          yield* sql`INSERT INTO preserved_auth_migration_data (value) VALUES ('keep')`;
          yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('old-browser', 'one-time-token', '["orchestration:read"]', 'browser-session-cookie',
          '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z')
      `;
          yield* runMigrations({ toMigrationInclusive: 79 });
          const tables = yield* sql<{
            readonly name: string;
          }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_pairing_links'`;
          expect(tables).toHaveLength(0);
          const [old] = yield* sql<{
            readonly revoked_at: string | null;
          }>`SELECT revoked_at FROM auth_sessions WHERE session_id = 'old-browser'`;
          expect(old?.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect(yield* sql`SELECT value FROM preserved_auth_migration_data`).toEqual([
            { value: "keep" },
          ]);
          expect(yield* sql`SELECT * FROM auth_policy_state`).toHaveLength(0);
        }),
    );
  },
);
