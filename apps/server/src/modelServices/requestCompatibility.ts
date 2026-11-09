import type { ModelServiceProtocol } from "@t3tools/contracts";

const GPT_REASONING_MODEL = /^gpt-[5-9](?:[.-]|$)/i;

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
