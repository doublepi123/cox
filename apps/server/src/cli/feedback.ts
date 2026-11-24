import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/cli";

import * as LocalFeedback from "../feedback/LocalFeedback.ts";
import { authLocationFlags, resolveCliAuthConfig } from "./config.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const feedbackListCommand = Command.make("list", authLocationFlags).pipe(
  Command.withDescription("Print recent local Cox feedback reports as JSON."),
  Command.withHandler(
    Effect.fn("cli.feedback.list")(function* (flags) {
      const { dbPath } = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel, {
        quietLogs: true,
      });
      const fs = yield* FileSystem.FileSystem;
      const reports = (yield* fs.exists(dbPath))
        ? yield* LocalFeedback.list.pipe(
            Effect.provide(NodeSqliteClient.layer({ filename: dbPath, readonly: true })),
          )
        : [];
      yield* Console.log(encodeJson(reports));
    }),
  ),
);

export const feedbackCommand = Command.make("feedback").pipe(
  Command.withDescription(
    "Read Cox reports recorded when the server has COX_AGENT_FEEDBACK_ENABLED=true.",
  ),
  Command.withSubcommands([feedbackListCommand]),
);
