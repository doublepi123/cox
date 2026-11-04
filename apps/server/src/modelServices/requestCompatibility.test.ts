import { describe, expect, it } from "@effect/vitest";
import type { ModelServiceProtocol } from "@t3tools/contracts";

import { modelServiceRequestBody } from "./requestCompatibility.ts";

describe("OpenAI wire effort compatibility", () => {
  it.each(["gpt-6.1-sol", "openai/gpt-6.1-sol", "gpt-5.6-sol"])(
    "matches native Codex's ultra to max conversion for %s",
    (model) => {
      const chat = {
        model,
        reasoning_effort: "ultra",
        tools: [{ name: "tool" }],
        service_tier: "priority",
      };
      expect(modelServiceRequestBody("openai-chat", model, chat)).toEqual({
        ...chat,
        reasoning_effort: "max",
      });
      const responses = {
        model,
        reasoning: { effort: "ultra", summary: "detailed" },
        input: "hi",
        service_tier: "priority",
      };
      expect(modelServiceRequestBody("openai-responses", model, responses)).toEqual({
        ...responses,
        reasoning: { effort: "max", summary: "detailed" },
      });
      expect(chat.reasoning_effort).toBe("ultra");
      expect(responses.reasoning.effort).toBe("ultra");
    },
  );

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "vendor-effort"])(
    "does not alter explicit %s effort",
    (effort) => {
      const chat = { reasoning_effort: effort };
      const responses = { reasoning: { effort } };
      expect(modelServiceRequestBody("openai-chat", "gpt-6.1-sol", chat)).toBe(chat);
      expect(modelServiceRequestBody("openai-responses", "gpt-6.1-sol", responses)).toBe(responses);
    },
  );

  it.each(["Vendor/Exact", "qwen3.8-max", "claude-opus-4-8", "custom-gpt-6.1-sol", "o3"])(
    "preserves service-defined effort for %s",
    (model) => {
      const body = { reasoning_effort: "ultra", reasoning: { effort: "ultra" } };
      expect(modelServiceRequestBody("openai-chat", model, body)).toBe(body);
      expect(modelServiceRequestBody("openai-responses", model, body)).toBe(body);
    },
  );

  it.each(["anthropic-messages", "gemini"] satisfies ReadonlyArray<ModelServiceProtocol>)(
    "keeps the original request for %s",
    (protocol) => {
      const body = { model: "gpt-6.1-sol", output_config: { effort: "ultra" } };
      expect(modelServiceRequestBody(protocol, "gpt-6.1-sol", body)).toBe(body);
    },
  );
});
