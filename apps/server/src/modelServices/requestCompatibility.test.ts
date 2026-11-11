import { describe, expect, it } from "@effect/vitest";
import type { ModelServiceProtocol } from "@t3tools/contracts";

import {
  modelServiceRequestBody,
  modelServiceRequestOutputBudget,
  withoutEncryptedReasoning,
} from "./requestCompatibility.ts";

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

describe("model metadata output budgets", () => {
  it.each([
    {
      protocol: "openai-responses" as const,
      body: { input: "hello", reasoning: { effort: "max" } },
      field: "max_output_tokens",
    },
    {
      protocol: "openai-chat" as const,
      body: { messages: [], reasoning_effort: "high" },
      field: "max_tokens",
    },
    {
      protocol: "openai-chat" as const,
      body: { messages: [], reasoning_effort: "max" },
      field: "max_completion_tokens",
      model: "vendor/o3",
    },
    {
      protocol: "anthropic-messages" as const,
      body: { messages: [], thinking: { type: "enabled", budget_tokens: 16000 } },
      field: "max_tokens",
    },
    {
      protocol: "gemini" as const,
      body: { contents: [], generationConfig: { temperature: 0.2, candidateCount: 1 } },
      field: "generationConfig.maxOutputTokens",
    },
  ])("uses the selected model's output budget for $protocol", ({ protocol, body, ...options }) => {
    const model = "model" in options ? options.model : "claude-opus-5-5";
    const result = modelServiceRequestOutputBudget(protocol, model, body, 128000);
    expect(result.field).toBe(options.field);
    const value = options.field.includes(".")
      ? (result.body.generationConfig as Record<string, unknown>).maxOutputTokens
      : result.body[options.field];
    expect(value).toBe(128000);
    expect(result.body).toMatchObject(body);
    expect(result.body).not.toBe(body);
    if (protocol === "openai-chat" && options.field === "max_completion_tokens") {
      expect(result.body.max_tokens).toBeUndefined();
    }
    if (protocol === "anthropic-messages") expect(body.thinking.budget_tokens).toBe(16000);
  });

  it.each([
    { protocol: "openai-responses" as const, body: { max_output_tokens: 1024 } },
    { protocol: "openai-chat" as const, body: { max_tokens: 8192 } },
    { protocol: "openai-chat" as const, body: { max_completion_tokens: 1024 } },
    { protocol: "anthropic-messages" as const, body: { max_tokens: null } },
    { protocol: "gemini" as const, body: { generationConfig: { maxOutputTokens: 8192 } } },
    { protocol: "gemini" as const, body: { generationConfig: { maxOutputTokens: "bad" } } },
  ])("does not replace an explicit budget: $protocol $body", ({ protocol, body }) => {
    const result = modelServiceRequestOutputBudget(protocol, "model", body, 128000);
    expect(result).toEqual({ body });
    expect(result.body).toBe(body);
  });

  it.each([undefined, null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not guess when model metadata is invalid: %s",
    (maxOutputTokens) => {
      const body = { messages: [] };
      expect(
        modelServiceRequestOutputBudget(
          "openai-chat",
          "model",
          body,
          maxOutputTokens as number | undefined,
        ),
      ).toEqual({ body });
    },
  );

  it("keeps malformed generation configuration unchanged", () => {
    for (const generationConfig of [null, "invalid", []]) {
      const body = { generationConfig };
      expect(modelServiceRequestOutputBudget("gemini", "model", body, 128000)).toEqual({ body });
    }
  });

  it.each([1024, 8192, 256000])("preserves an explicit budget across conversion: %s", (value) => {
    for (const [protocol, body] of [
      ["openai-responses", { max_output_tokens: value }],
      ["openai-chat", { max_completion_tokens: value }],
      ["anthropic-messages", { max_tokens: value }],
      ["gemini", { generationConfig: { maxOutputTokens: value } }],
    ] as const) {
      const converted = { max_tokens: 4096, reasoning_effort: "max" };
      if (protocol === "openai-chat") continue;
      const result = modelServiceRequestOutputBudget(
        "openai-chat",
        "vendor/o3",
        converted,
        128000,
        {
          protocol,
          body,
        },
      );
      expect(result.body).toEqual({ max_completion_tokens: value, reasoning_effort: "max" });
      expect(converted.max_tokens).toBe(4096);
      expect(result.field).toBeUndefined();
    }
  });

  it.each([null, 0, -1, "8192", 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an unrepresentable explicit budget during conversion: %s",
    (value) => {
      const converted = { max_tokens: 4096 };
      const result = modelServiceRequestOutputBudget("openai-chat", "model", converted, 128000, {
        protocol: "openai-responses",
        body: { max_output_tokens: value },
      });
      expect(result.body).toBe(converted);
      expect(result.error).toContain("explicit output token budget");
    },
  );

  it("uses model metadata instead of a converter default only when the agent omitted its budget", () => {
    const converted = { max_tokens: 4096, thinking: { budget_tokens: 1000 } };
    expect(
      modelServiceRequestOutputBudget("anthropic-messages", "model", converted, 128000, {
        protocol: "openai-responses",
        body: { input: "hello" },
      }),
    ).toMatchObject({
      body: { max_tokens: 128000, thinking: { budget_tokens: 1000 } },
      field: "max_tokens",
    });
    expect(
      modelServiceRequestOutputBudget("anthropic-messages", "model", converted, undefined, {
        protocol: "openai-responses",
        body: { input: "hello" },
      }),
    ).toEqual({ body: converted });
  });

  it("rejects conflicting Chat fields rather than choosing one during conversion", () => {
    const result = modelServiceRequestOutputBudget("openai-responses", "model", {}, 128000, {
      protocol: "openai-chat",
      body: { max_tokens: 1024, max_completion_tokens: 8192 },
    });
    expect(result.error).toContain("Conflicting");
  });

  it("does not inject metadata outside Gemini's integer range", () => {
    const body = { generationConfig: { temperature: 0.2 } };
    expect(modelServiceRequestOutputBudget("gemini", "model", body, 2147483648)).toEqual({ body });
    expect(
      modelServiceRequestOutputBudget("gemini", "model", body, 2147483648, {
        protocol: "openai-responses",
        body: {},
      }),
    ).toEqual({ body });
    expect(
      modelServiceRequestOutputBudget("gemini", "model", body, 128000, {
        protocol: "openai-responses",
        body: { max_output_tokens: 2147483648 },
      }).error,
    ).toBeDefined();
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
