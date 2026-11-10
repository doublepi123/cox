import { describe, expect, it } from "vite-plus/test";
import { modelServiceHasReasoning, modelServiceStreamEvent } from "./responseProgress.ts";

describe("model service response progress", () => {
  it("ignores stream setup and recognizes reasoning, tools and valid completion", () => {
    expect(
      modelServiceStreamEvent("openai-responses", 'data: {"type":"response.created"}').progress,
    ).toBe(false);
    expect(
      modelServiceStreamEvent(
        "anthropic-messages",
        'data: {"type":"message_start","message":{"id":"pending"}}',
      ).progress,
    ).toBe(false);
    expect(
      modelServiceStreamEvent("openai-chat", 'data: {"choices":[{"delta":{"role":"assistant"}}]}')
        .progress,
    ).toBe(false);
    expect(
      modelServiceStreamEvent(
        "openai-responses",
        'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking"}',
      ).progress,
    ).toBe(true);
    expect(
      modelServiceStreamEvent(
        "anthropic-messages",
        'data: {"type":"content_block_start","content_block":{"type":"tool_use","id":"tool"}}',
      ).progress,
    ).toBe(true);
    expect(
      modelServiceStreamEvent(
        "gemini",
        'data: {"candidates":[{"content":{"parts":[{"text":"thinking","thought":true}]}}]}',
      ).progress,
    ).toBe(true);
    expect(
      modelServiceStreamEvent(
        "openai-chat",
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      ).progress,
    ).toBe(true);
    expect(modelServiceStreamEvent("openai-chat", "data: [DONE]").progress).toBe(false);
  });
  it("detects failures carried by successful HTTP streams", () => {
    expect(
      modelServiceStreamEvent(
        "openai-responses",
        'data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}',
      ).error,
    ).toEqual({ code: "server_error" });
    expect(
      modelServiceStreamEvent(
        "anthropic-messages",
        'data: {"type":"error","error":{"type":"overloaded_error"}}',
      ).error,
    ).toEqual({ type: "overloaded_error" });
  });
  it("treats a protocol-declared incomplete response as a result, not a retryable rejection", () => {
    expect(
      modelServiceStreamEvent(
        "openai-responses",
        'data: {"type":"response.incomplete","response":{"status":"incomplete","output":[],"incomplete_details":{"reason":"max_output_tokens"}}}',
      ),
    ).toEqual({ progress: true });
  });
  it("chooses the reasoning threshold from actual request options", () => {
    expect(modelServiceHasReasoning({ reasoning: { effort: "high" } })).toBe(true);
    expect(modelServiceHasReasoning({ reasoning_effort: "none" }, true)).toBe(false);
    expect(modelServiceHasReasoning({ thinking: { type: "adaptive" } })).toBe(true);
    expect(modelServiceHasReasoning({ thinking: { type: "disabled" } }, true)).toBe(false);
    expect(modelServiceHasReasoning({}, true)).toBe(true);
    expect(modelServiceHasReasoning({})).toBe(false);
  });
});
