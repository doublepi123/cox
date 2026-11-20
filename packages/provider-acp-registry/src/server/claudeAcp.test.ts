import { describe, expect, it } from "@effect/vitest";

import { extractClaudeSubagentSessionEvent } from "./claudeAcp.ts";

describe("Claude ACP child turn outcomes", () => {
  it.each([
    ["refusal", "failed", "refused"],
    ["max_tokens", "failed", "output token limit"],
    ["max_turn_requests", "failed", "request limit"],
    ["end_turn", "completed", null],
    ["cancelled", "cancelled", null],
  ] as const)("projects %s as %s", (stopReason, status, message) => {
    expect(
      extractClaudeSubagentSessionEvent({
        sessionId: "parent",
        update: {
          sessionUpdate: "_t3_unknown",
          originalSessionUpdate: "subagent_update",
          raw: { sessionId: "child", state: { state: "idle", stopReason } },
        },
      }),
    ).toMatchObject({
      type: "state",
      status,
      result: message === null ? null : expect.stringContaining(message),
    });
  });
});
