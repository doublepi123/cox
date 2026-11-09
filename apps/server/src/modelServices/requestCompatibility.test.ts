import { describe, expect, it } from "@effect/vitest";
import type { ModelServiceProtocol } from "@t3tools/contracts";

import { modelServiceRequestBody, withoutEncryptedReasoning } from "./requestCompatibility.ts";

describe("encrypted Responses reasoning compatibility", () => {
  it("removes only reasoning ciphertext and leaves messages and tool history untouched", () => {
    const message = { type: "message", role: "user", content: "Keep encrypted_content in prose" };
    const tool = {
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "Read",
      arguments: '{"encrypted_content":"data"}',
    };
    const result = {
      type: "function_call_output",
      call_id: "call_1",
      output: "file data",
      encrypted_content: "not reasoning",
    };
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "opaque-secret",
      summary: [{ type: "summary_text", text: "Preserve summary" }],
      content: [{ type: "reasoning_text", text: "Preserve reasoning" }],
    };
    const body = {
      model: "Vendor/Exact",
      input: [message, reasoning, tool, result],
      reasoning: { effort: "high" },
      tools: [{ type: "function", strict: false }],
    };
    const cleaned = withoutEncryptedReasoning(body);
    const { encrypted_content: _encrypted, ...retained } = reasoning;
    expect(cleaned).toEqual({ ...body, input: [message, retained, tool, result] });
    expect(body.input[1]).toBe(reasoning);
    expect(reasoning.encrypted_content).toBe("opaque-secret");
    expect((cleaned.input as unknown[])[0]).toBe(message);
    expect((cleaned.input as unknown[])[2]).toBe(tool);
    expect((cleaned.input as unknown[])[3]).toBe(result);
    expect(cleaned.tools).toBe(body.tools);
  });

  it("omits otherwise empty reasoning items instead of replaying an orphan item ID", () => {
    const body = {
      input: [
        { type: "reasoning", id: "rs_1", encrypted_content: "cipher-one", summary: [] },
        { type: "reasoning", id: "rs_2", encrypted_content: "cipher-two" },
        { type: "reasoning", id: "rs_plain", summary: [] },
        { type: "item_reference", id: "rs_reference" },
        { role: "user", content: "hello" },
      ],
    };
    expect(withoutEncryptedReasoning(body)).toEqual({ input: body.input.slice(2) });
    expect(body.input).toHaveLength(5);
  });

  it.each([
    { input: "hello" },
    { input: [{ type: "reasoning", summary: [] }] },
    { messages: [{ role: "user", encrypted_content: "not Responses reasoning" }] },
    { input: [null, "test", 1, ["nested"], { role: "user", content: "test" }] },
  ])("does not change requests without encrypted reasoning: %j", (body) => {
    expect(withoutEncryptedReasoning(body)).toBe(body);
  });
});

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
