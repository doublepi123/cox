import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestrationV2RpcSchemas } from "./orchestrationV2.ts";
import { ThreadProjectMoveMcpInput } from "./threadProjectMoveMcp.ts";

const decode = Schema.decodeUnknownSync(ThreadProjectMoveMcpInput);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2RpcSchemas.dispatchCommand.input);

describe("ThreadProjectMoveMcpInput", () => {
  it("defaults to the calling thread and accepts a guarded, retryable move", () => {
    expect(decode({ projectId: "project-b" })).toEqual({ projectId: "project-b" });
    const input = {
      projectId: "project-b",
      threadId: "thread-a",
      expectedProjectId: "project-a",
      continuationPrompt: "Continue here.",
      clientRequestId: "move-1",
    };
    expect(decode(input)).toEqual(input);
  });

  it("rejects missing destinations, empty prompts and invalid retry keys", () => {
    for (const input of [
      {},
      { projectId: " " },
      { projectId: "project-b", continuationPrompt: " " },
      { projectId: "project-b", continuationPrompt: "a".repeat(120_001) },
      { projectId: "project-b", clientRequestId: "\ud800" },
    ]) {
      expect(() => decode(input)).toThrow();
    }
  });

  it("does not expose active-agent ownership fields to browser dispatch", () => {
    expect(() =>
      decodeCommand({
        type: "thread.project.move-agent",
        commandId: "move-1",
        threadId: "thread-a",
        projectId: "project-b",
        expectedProjectId: "project-a",
        runId: "run-1",
        providerSessionId: "session-1",
        continuationPrompt: "Continue here.",
      }),
    ).toThrow();
  });
});
