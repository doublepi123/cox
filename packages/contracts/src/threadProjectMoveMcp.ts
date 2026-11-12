import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorMcpClientRequestId } from "./orchestratorMcp.ts";

export const ThreadProjectMoveMcpInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  projectId: ProjectId,
  expectedProjectId: Schema.optional(ProjectId),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  continuationPrompt: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
      description: "Work to resume after moving this active thread. Default: confirm the move.",
    }),
  ),
});
export type ThreadProjectMoveMcpInput = typeof ThreadProjectMoveMcpInput.Type;

export const ThreadProjectMoveMcpResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: TrimmedNonEmptyString,
  sequence: Schema.NullOr(NonNegativeInt),
  agent: Schema.Literals(["restart_scheduled", "refresh_on_next_turn", "unchanged"]),
  link: Schema.String,
});
export type ThreadProjectMoveMcpResult = typeof ThreadProjectMoveMcpResult.Type;
