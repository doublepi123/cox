import {
  type MilestoneEvent as MilestoneEventValue,
  MilestoneEvent,
  type MilestoneFilter,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { McpServer } from "effect/ai";

import * as MilestoneHub from "./MilestoneHub.ts";

// Matches the hub's buffer, so a poll can drain everything it keeps at once.
const MAX_EVENTS = 1_000;
const DEFAULT_EVENTS = 100;

const includeSubagentChildren = Schema.optional(
  Schema.Boolean.annotate({
    description: "Also subagent threads and runs another run invoked.",
  }),
);
const workflowRunIds = Schema.optional(Schema.Array(TrimmedNonEmptyString));

const WorkflowParameters = Schema.Struct({
  workflows: Schema.optional(
    Schema.Array(TrimmedNonEmptyString).annotate({ description: "Workflow names." }),
  ),
  workflowRunIds,
  includeSubagentChildren,
});

const DESCRIPTIONS: Record<MilestoneEventValue["type"], string> = {
  "workflow.run_started": "A workflow run started.",
  "workflow.needs_input": "A workflow run asks a person a question.",
  "workflow.input_resolved":
    "A workflow run's question was answered, timed out, or ended with its run.",
  "workflow.run_paused": "A workflow run paused: a step failed, or someone paused it.",
  "workflow.run_resumed": "A paused workflow run went on again.",
  "workflow.run_ended": "A workflow run ended: completed, stopped, skipped or cancelled.",
};

const occurrence = ({ event }: MilestoneHub.PositionedMilestone) => ({
  eventId: event.id,
  timestamp: event.occurredAt,
  data: event,
});

/**
 * Each milestone type as an MCP event type (SEP-3415), for outside clients to poll or stream.
 * Cursors are the hub's, so a client that was away catches up on what the hub still keeps.
 * Workflow runs have no project or thread, so their types are narrowed by workflow and run.
 */
export const make = Effect.gen(function* () {
  const hub = yield* MilestoneHub.MilestoneHub;
  return MilestoneEvent.members.map((payload) => eventOf(hub, payload, WorkflowParameters));
});

const eventOf = <P extends typeof WorkflowParameters>(
  hub: MilestoneHub.MilestoneHub["Service"],
  payload: (typeof MilestoneEvent.members)[number],
  parameters: P,
) => {
  const type = payload.fields.type.literal;
  const filterOf = (args: P["Type"]): MilestoneFilter => ({ ...args, types: [type] });
  return {
    name: type,
    description: DESCRIPTIONS[type],
    parameters,
    payload,
    poll: (args, request) =>
      hub
        .read({
          cursor: request.cursor,
          maxAgeMs: request.maxAgeMs,
          filter: filterOf(args),
          limit: Math.min(request.maxEvents ?? DEFAULT_EVENTS, MAX_EVENTS),
        })
        .pipe(Effect.map((page) => ({ ...page, events: page.events.map(occurrence) }))),
    stream: (args, request) =>
      hub
        .follow({ cursor: request.cursor, maxAgeMs: request.maxAgeMs, filter: filterOf(args) })
        .pipe(
          Effect.map(({ cursor, truncated, items }) => ({
            cursor,
            truncated,
            items: items.pipe(
              Stream.map((item): McpServer.EventStreamItem<MilestoneEventValue> =>
                item._tag === "Milestone"
                  ? { _tag: "Event", cursor: item.cursor, ...occurrence(item) }
                  : item,
              ),
            ),
          })),
        ),
  } satisfies McpServer.EventOptions<P, typeof payload, never>;
};
