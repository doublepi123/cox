import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { DEFERRED_COMMAND_MESSAGE_CONDITION } from "../../orchestration-v2/deferredCommandMessage.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Match the predicate used by the turn-start query.
  yield* sql.unsafe(`
    CREATE INDEX orchestration_v2_projection_messages_deferred_command_idx
    ON orchestration_v2_projection_messages(thread_id, created_at, message_id)
    WHERE ${DEFERRED_COMMAND_MESSAGE_CONDITION}
  `);
});
