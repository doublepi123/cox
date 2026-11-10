import { describe, expect, it } from "vite-plus/test";
import { chatResponseOutput, makeChatOutputTracker } from "./responseOutput.ts";

describe("Chat response output metadata", () => {
  it("identifies only an explicit zero-token normal stop with no generated output", () => {
    const tracker = makeChatOutputTracker();
    tracker.observe({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
    tracker.observe({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    expect(tracker.isZeroTokenStop()).toBe(false);
    tracker.observe({ choices: [], usage: { prompt_tokens: 301284, completion_tokens: 0 } });
    expect(tracker.isZeroTokenStop()).toBe(true);
    expect(tracker.snapshot()).toEqual({
      textCharacters: 0,
      reasoningCharacters: 0,
      refusalCharacters: 0,
      toolCallFragments: 0,
      otherOutput: false,
      outputTokens: 0,
      reasoningTokens: undefined,
      choiceCount: 1,
      classificationAmbiguous: false,
    });
  });

  it.each([
    { name: "no usage", usage: undefined, delta: {}, reason: "stop" },
    { name: "nonzero generation", usage: { completion_tokens: 1 }, delta: {}, reason: "stop" },
    {
      name: "reasoning tokens",
      usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: 1 } },
      delta: {},
      reason: "stop",
    },
    {
      name: "reasoning alias tokens",
      usage: { output_tokens: 0, output_tokens_details: { reasoning_tokens: 1 } },
      delta: {},
      reason: "stop",
    },
    { name: "length", usage: { completion_tokens: 0 }, delta: {}, reason: "length" },
    { name: "filter", usage: { completion_tokens: 0 }, delta: {}, reason: "content_filter" },
    { name: "tools finish", usage: { completion_tokens: 0 }, delta: {}, reason: "tool_calls" },
    { name: "missing finish", usage: { completion_tokens: 0 }, delta: {}, reason: null },
    { name: "text", usage: { completion_tokens: 0 }, delta: { content: "OK" }, reason: "stop" },
    {
      name: "reasoning",
      usage: { completion_tokens: 0 },
      delta: { reasoning_content: "private reasoning" },
      reason: "stop",
    },
    {
      name: "reasoning alias",
      usage: { completion_tokens: 0 },
      delta: { reasoning: "private reasoning" },
      reason: "stop",
    },
    {
      name: "refusal",
      usage: { completion_tokens: 0 },
      delta: { refusal: "Cannot comply" },
      reason: "stop",
    },
    {
      name: "tool",
      usage: { completion_tokens: 0 },
      delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
      reason: "stop",
    },
    {
      name: "legacy tool",
      usage: { completion_tokens: 0 },
      delta: { function_call: { name: "read" } },
      reason: "stop",
    },
    {
      name: "audio",
      usage: { completion_tokens: 0 },
      delta: { audio: { id: "private-id" } },
      reason: "stop",
    },
    {
      name: "structured content",
      usage: { completion_tokens: 0 },
      delta: { content: [{ type: "output_text", text: "hello" }] },
      reason: "stop",
    },
    {
      name: "opaque reasoning output",
      usage: { completion_tokens: 0 },
      delta: { reasoning_details: [] },
      reason: "stop",
    },
    {
      name: "unknown provider output extension",
      usage: { completion_tokens: 0 },
      delta: { provider_content: "private extension" },
      reason: "stop",
    },
    { name: "malformed tokens", usage: { completion_tokens: "0" }, delta: {}, reason: "stop" },
    {
      name: "malformed alternative tokens",
      usage: { completion_tokens: 0, output_tokens: "5" },
      delta: {},
      reason: "stop",
    },
    {
      name: "malformed reasoning tokens",
      usage: { completion_tokens: 0, completion_tokens_details: { reasoning_tokens: "5" } },
      delta: {},
      reason: "stop",
    },
  ])("does not misclassify $name as a zero-token stop", ({ usage, delta, reason }) => {
    const tracker = makeChatOutputTracker();
    tracker.observe({ choices: [{ index: 0, delta, finish_reason: reason }], usage });
    expect(tracker.isZeroTokenStop()).toBe(false);
    const metadata = JSON.stringify(tracker.snapshot());
    expect(metadata).not.toContain("private");
    expect(metadata).not.toContain("Cannot comply");
  });

  it("does not classify unfinished or truncated choices as successful empty stops", () => {
    const tracker = makeChatOutputTracker();
    tracker.observe({
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
        { index: 1, delta: {} },
      ],
      usage: { completion_tokens: 0 },
    });
    expect(tracker.isZeroTokenStop()).toBe(false);
    tracker.observe({ choices: [{ index: 1, delta: {}, finish_reason: "length" }] });
    expect(tracker.isZeroTokenStop()).toBe(false);
  });

  it("treats conflicting usage as ambiguous instead of deleting evidence of generation", () => {
    const tracker = makeChatOutputTracker();
    tracker.observe({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 5 },
    });
    tracker.observe({ choices: [], usage: { completion_tokens: 0 } });
    expect(tracker.isZeroTokenStop()).toBe(false);
    expect(tracker.snapshot().classificationAmbiguous).toBe(true);
  });

  it("classifies nonstream Chat with the same narrow metadata rule", () => {
    expect(
      chatResponseOutput({
        choices: [
          { index: 0, message: { role: "assistant", content: null }, finish_reason: "stop" },
        ],
        usage: { completion_tokens: 0 },
      }).zeroTokenStop,
    ).toBe(true);
  });
});
