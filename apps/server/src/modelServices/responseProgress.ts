import type { ModelServiceProtocol } from "@t3tools/contracts";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const nonempty = (value: unknown) => typeof value === "string" && value.length > 0;

export function modelServiceResponseIsValid(
  protocol: ModelServiceProtocol,
  value: unknown,
): boolean {
  const body = record(value);
  if (protocol === "openai-chat")
    return (
      Array.isArray(body.choices) &&
      body.choices.some(
        (value) =>
          Object.keys(record(record(value).message)).length > 0 ||
          typeof record(value).finish_reason === "string",
      )
    );
  if (protocol === "openai-responses")
    return ["completed", "incomplete"].includes(String(body.status)) && Array.isArray(body.output);
  if (protocol === "anthropic-messages")
    return (
      Array.isArray(body.content) &&
      (body.type === "message" || typeof body.stop_reason === "string")
    );
  return (
    (Array.isArray(body.candidates) && body.candidates.length > 0) ||
    Boolean(record(body.promptFeedback).blockReason)
  );
}

export function modelServiceStreamEvent(
  protocol: ModelServiceProtocol,
  frame: string,
): {
  readonly progress: boolean;
  readonly error?: Record<string, unknown>;
} {
  const data = frame.replace(/^data:\s?/, "");
  if (data === "[DONE]") return { progress: false };
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return { progress: false };
  }
  const event = record(value);
  const type = event.type;
  if (event.error || type === "error" || type === "response.failed") {
    return {
      progress: false,
      error: record(
        event.error ??
          record(event.response).error ??
          record(event.response).incomplete_details ??
          event,
      ),
    };
  }
  if (protocol === "openai-chat") {
    const choices = Array.isArray(event.choices) ? event.choices : [];
    return {
      progress: choices.some((value) => {
        const choice = record(value);
        const delta = record(choice.delta);
        return (
          nonempty(delta.content) ||
          nonempty(delta.reasoning_content) ||
          nonempty(delta.reasoning) ||
          nonempty(delta.refusal) ||
          (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) ||
          typeof choice.finish_reason === "string"
        );
      }),
    };
  }
  if (protocol === "openai-responses") {
    return {
      progress:
        type === "response.completed" ||
        type === "response.incomplete" ||
        (typeof type === "string" && type.endsWith(".delta") && nonempty(event.delta)) ||
        (type === "response.output_item.added" &&
          ["function_call", "custom_tool_call"].includes(String(record(event.item).type))),
    };
  }
  if (protocol === "anthropic-messages") {
    const delta = record(event.delta);
    const block = record(event.content_block);
    return {
      progress:
        type === "message_stop" ||
        (type === "message_delta" && typeof delta.stop_reason === "string") ||
        (type === "content_block_delta" &&
          [delta.text, delta.thinking, delta.partial_json].some(nonempty)) ||
        (type === "content_block_start" &&
          (block.type === "tool_use" || nonempty(block.text) || nonempty(block.thinking))),
    };
  }
  const candidates = Array.isArray(event.candidates) ? event.candidates : [];
  return {
    progress: candidates.some((value) => {
      const candidate = record(value);
      const parts = record(candidate.content).parts;
      return (
        typeof candidate.finishReason === "string" ||
        (Array.isArray(parts) &&
          parts.some((value) => {
            const part = record(value);
            return (
              nonempty(part.text) ||
              Boolean(part.functionCall || part.inlineData || part.executableCode)
            );
          }))
      );
    }),
  };
}

export function modelServiceHasReasoning(
  body: Record<string, unknown>,
  supported?: boolean,
): boolean {
  const effort =
    body.reasoning_effort ?? record(body.reasoning).effort ?? record(body.output_config).effort;
  if (typeof effort === "string") return !["none", "off", "minimal", "low"].includes(effort);
  const thinking = record(body.thinking);
  if (thinking.type === "disabled") return false;
  const google = record(record(body.generationConfig).thinkingConfig);
  if (google.thinkingBudget === 0) return false;
  return (
    thinking.type === "enabled" ||
    thinking.type === "adaptive" ||
    Boolean(google.includeThoughts) ||
    typeof google.thinkingBudget === "number" ||
    (typeof google.thinkingLevel === "string" &&
      !["NONE", "OFF", "LOW", "MINIMAL"].includes(google.thinkingLevel.toUpperCase())) ||
    supported === true
  );
}
