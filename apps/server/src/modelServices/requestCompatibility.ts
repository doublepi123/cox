import type { ModelServiceProtocol } from "@t3tools/contracts";

const GPT_REASONING_MODEL = /^gpt-[5-9](?:[.-]|$)/i;

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
