import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2TurnItemVisible,
  isReasoningPlaceholder,
} from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");

describe("reasoning placeholders", () => {
  it.each(["[reasoning unavailable]", " \n[Reasoning Unavailable]\t", "[", "[reasoning un"])(
    "recognizes complete or partially streamed placeholder %j",
    (text) => expect(isReasoningPlaceholder(text)).toBe(true),
  );

  it.each(["", "Inspect the diff", "[1, 2]", "[reasoning unavailable] is a placeholder"])(
    "keeps ordinary content %j",
    (text) => expect(isReasoningPlaceholder(text)).toBe(false),
  );
});

describe.each([
  ["point", isOrchestrationV2TurnItemVisible],
  [
    "indexed",
    (input: Parameters<typeof isOrchestrationV2TurnItemVisible>[0]) =>
      createOrchestrationV2TurnItemVisibility(input)(input.item),
  ],
] as const)("%s timeline visibility", (_, isVisible) => {
  it("hides unpaired interruption results from superseded attempts", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps paired interruption results from superseded attempts", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts without a request", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("hides queued user messages once their run is cancelled", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps non-queued user messages on cancelled runs", () => {
    expect(
      isVisible({
        item: { type: "user_message", inputIntent: "turn_start", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "turn_start", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });
});
