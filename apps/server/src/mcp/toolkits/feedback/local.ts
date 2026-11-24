import { hostname } from "node:os";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as LocalFeedback from "../../../feedback/LocalFeedback.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

export const LocalFeedbackToolkit = Toolkit.make(
  Tool.make("cox_feedback", {
    description:
      "Save a report about a Cox tool, command, or feature to the local Cox feedback log. Describe the issue in your own words and omit messages, code, and names.",
    parameters: LocalFeedback.ReportInput,
    success: Schema.Struct({ id: Schema.String }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      SqlClient.SqlClient,
      SecureRandom.SecureRandom,
    ],
  })
    .annotate(Tool.Destructive, false)
    .annotate(McpSchema.EnabledWhen, McpInvocationContext.feedbackEnabled),
);

export const layer = McpToolAccess.toLayer(LocalFeedbackToolkit, {
  cox_feedback: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.localFeedbackEnabled !== true) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "Local Cox feedback is disabled.",
        });
      }
      return yield* LocalFeedback.save(input, scope.thread?.threadId ?? null, [
        hostname(),
        process.env.USER ?? process.env.USERNAME ?? "",
      ]).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Could not save the local Cox feedback report.",
            }),
        ),
      );
    }),
  ),
});
