import type { ModelServiceProtocol } from "@t3tools/contracts";

const GPT_REASONING_MODEL = /^gpt-[5-9](?:[.-]|$)/i;
const CHAT_COMPLETION_BUDGET_MODEL = /^(?:gpt-[5-9]|o[1-9])(?:[.-]|$)/i;

export function withoutForcedToolChoice(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const choice = body.tool_choice;
  if (
    choice !== "required" &&
    !(
      choice !== null &&
      typeof choice === "object" &&
      "type" in choice &&
      choice.type === "function"
    )
  )
    return body;
  return { ...body, tool_choice: "auto" };
}

export function withoutForcedToolThinking(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const choice = body.tool_choice;
  const forced =
    choice === "required" ||
    (choice !== null &&
      typeof choice === "object" &&
      "type" in choice &&
      choice.type === "function");
  const thinking = body.thinking;
  const enabledThinking =
    thinking !== null &&
    typeof thinking === "object" &&
    "type" in thinking &&
    thinking.type === "enabled";
  if (!forced || (body.reasoning_effort === "none" && !enabledThinking)) return body;
  return {
    ...body,
    reasoning_effort: "none",
    ...(thinking === undefined ? {} : { thinking: { type: "disabled" } }),
  };
}

function outputBudgetFields(
  protocol: ModelServiceProtocol,
  body: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, unknown]> {
  if (protocol === "gemini") {
    const config = body.generationConfig;
    return config !== null && typeof config === "object" && "maxOutputTokens" in config
      ? [["generationConfig.maxOutputTokens", config.maxOutputTokens]]
      : [];
  }
  const fields =
    protocol === "openai-chat"
      ? ["max_tokens", "max_completion_tokens"]
      : [protocol === "openai-responses" ? "max_output_tokens" : "max_tokens"];
  return fields.filter((field) => field in body).map((field) => [field, body[field]] as const);
}

export function modelServiceRequestOutputBudget(
  protocol: ModelServiceProtocol,
  model: string,
  body: Readonly<Record<string, unknown>>,
  maxOutputTokens: number | undefined,
  original?: {
    readonly protocol: ModelServiceProtocol;
    readonly body: Readonly<Record<string, unknown>>;
  },
): {
  readonly body: Readonly<Record<string, unknown>>;
  readonly field?: string;
  readonly error?: string;
} {
  if (original && original.protocol !== protocol) {
    const fields = outputBudgetFields(original.protocol, original.body);
    if (fields.length > 1)
      return { body, error: "Conflicting output token budget fields cannot be converted." };
    const explicit = fields[0];
    const value = explicit ? explicit[1] : maxOutputTokens;
    if (
      explicit &&
      (typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        ((protocol === "gemini" || original.protocol === "gemini") && value > 2147483647))
    )
      return {
        body,
        error: "The explicit output token budget cannot be represented by the upstream protocol.",
      };
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return { body };
    if (protocol === "gemini" && value > 2147483647) return { body };
    const converted = { ...body };
    if (protocol === "gemini") {
      const config = converted.generationConfig;
      if (config !== null && typeof config === "object" && !Array.isArray(config)) {
        const { maxOutputTokens: _budget, ...rest } = config as Record<string, unknown>;
        converted.generationConfig = rest;
      }
    } else {
      for (const [field] of outputBudgetFields(protocol, converted)) delete converted[field];
    }
    const result = modelServiceRequestOutputBudget(protocol, model, converted, value);
    return explicit ? { body: result.body } : result;
  }
  if (
    maxOutputTokens === undefined ||
    !Number.isSafeInteger(maxOutputTokens) ||
    maxOutputTokens <= 0
  )
    return { body };
  if (protocol === "gemini" && maxOutputTokens > 2147483647) return { body };
  switch (protocol) {
    case "openai-responses":
      return "max_output_tokens" in body
        ? { body }
        : { body: { ...body, max_output_tokens: maxOutputTokens }, field: "max_output_tokens" };
    case "openai-chat": {
      if ("max_tokens" in body || "max_completion_tokens" in body) return { body };
      const field = CHAT_COMPLETION_BUDGET_MODEL.test(model.slice(model.lastIndexOf("/") + 1))
        ? "max_completion_tokens"
        : "max_tokens";
      return { body: { ...body, [field]: maxOutputTokens }, field };
    }
    case "anthropic-messages":
      return "max_tokens" in body
        ? { body }
        : { body: { ...body, max_tokens: maxOutputTokens }, field: "max_tokens" };
    case "gemini": {
      const generationConfig = body.generationConfig;
      if (generationConfig !== undefined) {
        if (
          generationConfig === null ||
          typeof generationConfig !== "object" ||
          Array.isArray(generationConfig)
        )
          return { body };
        if ("maxOutputTokens" in generationConfig) return { body };
      }
      return {
        body: {
          ...body,
          generationConfig: { ...generationConfig, maxOutputTokens },
        },
        field: "generationConfig.maxOutputTokens",
      };
    }
  }
}

export function withoutEncryptedReasoning(
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!Array.isArray(body.input)) return body;
  let changed = false;
  const input = body.input.flatMap((value: unknown) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [value];
    if (!("type" in value) || value.type !== "reasoning" || !("encrypted_content" in value))
      return [value];
    changed = true;
    const { encrypted_content: _encrypted, ...reasoning } = value;
    const content = "content" in reasoning ? reasoning.content : undefined;
    const summary = "summary" in reasoning ? reasoning.summary : undefined;
    return [content, summary].some((part) => Array.isArray(part) && part.length > 0)
      ? [reasoning]
      : [];
  });
  return changed ? { ...body, input } : body;
}

export function modelServiceRequestBody(
  protocol: ModelServiceProtocol,
  model: string,
  body: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (!GPT_REASONING_MODEL.test(model.slice(model.lastIndexOf("/") + 1))) return body;
  if (protocol === "openai-chat" && body.reasoning_effort === "ultra") {
    return { ...body, reasoning_effort: "max" };
  }
  const reasoning = body.reasoning;
  if (
    protocol === "openai-responses" &&
    reasoning !== null &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning) &&
    "effort" in reasoning &&
    reasoning.effort === "ultra"
  ) {
    return { ...body, reasoning: { ...reasoning, effort: "max" } };
  }
  return body;
}
