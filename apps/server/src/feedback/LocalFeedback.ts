import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";

import { scrubFeedback } from "./scrubFeedback.ts";

const Text = Schema.String.check(Schema.isMaxCodePoints(300));
export const ReportInput = Schema.Struct({
  kind: Schema.Literals(["bug", "confusing", "missing_capability", "wrong_docs", "other"]),
  subject: Text,
  expected: Text,
  actual: Text,
  workaround: Text.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
});

type Report = typeof ReportInput.Type & {
  readonly id: string;
  readonly threadId: string | null;
  readonly createdAt: string;
};

export const save = Effect.fn("LocalFeedback.save")(function* (
  input: typeof ReportInput.Type,
  threadId: string | null,
  sensitive: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const id = yield* random.uuidV7();
  const createdAt = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO agent_feedback (id, thread_id, created_at, kind, subject, expected, actual, workaround)
    VALUES (${id}, ${threadId}, ${createdAt}, ${input.kind},
      ${scrubFeedback(input.subject, sensitive)}, ${scrubFeedback(input.expected, sensitive)},
      ${scrubFeedback(input.actual, sensitive)}, ${scrubFeedback(input.workaround, sensitive)})
  `;
  return { id };
});

export const list = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'agent_feedback'`;
  if (tables.length === 0) return [];
  return yield* sql<Report>`
    SELECT id, thread_id AS "threadId", created_at AS "createdAt", kind, subject, expected, actual, workaround
    FROM agent_feedback ORDER BY rowid DESC LIMIT 50
  `;
});
