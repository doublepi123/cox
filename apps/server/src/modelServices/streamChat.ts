import type { ModelServiceStreamError } from "./streamIntegrity.ts";
import { streamRecord as record } from "./streamValues.ts";

const incompleteChatReasons = new Set(["length", "max_tokens", "content_filter"]);
interface ChatStreamTool {
  id: string;
  name: string;
  arguments: string;
}
interface ChatStreamChoice {
  reason: string | null;
  tools: Map<number, ChatStreamTool>;
}

export function makeChatStreamTracker(
  fail: (reason: ModelServiceStreamError["reason"], detail: string) => never,
  reason: (value: unknown) => void,
) {
  const chatChoices = new Map<number, ChatStreamChoice>();
  let toolCount = 0;
  let toolCharacters = 0;
  const observeChatChoice = (raw: unknown) => {
    const choice = record(raw);
    const index = choice.index ?? 0;
    if (!Number.isSafeInteger(index) || typeof index !== "number" || index < 0 || index >= 128)
      return fail("invalid_stream_event", "The model service sent an invalid Chat choice index.");
    const state = chatChoices.get(index) ?? {
      reason: null,
      tools: new Map<number, ChatStreamTool>(),
    };
    if (state.reason !== null) {
      const trailer = record(choice.delta);
      const accounting =
        (choice.finish_reason == null || choice.finish_reason === state.reason) &&
        [trailer.content, trailer.reasoning_content, trailer.reasoning, trailer.refusal].every(
          (value) => value == null || value === "",
        ) &&
        (trailer.tool_calls == null ||
          (Array.isArray(trailer.tool_calls) && trailer.tool_calls.length === 0)) &&
        trailer.function_call == null;
      if (accounting) return;
      return fail("invalid_stream_event", "The model service continued a finished Chat choice.");
    }
    chatChoices.set(index, state);
    if (choice.delta != null && (typeof choice.delta !== "object" || Array.isArray(choice.delta)))
      return fail("invalid_stream_event", "The model service sent an invalid Chat delta.");
    const delta = record(choice.delta);
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls))
      return fail("invalid_stream_event", "The model service sent invalid Chat tool calls.");
    const parts = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    const toolParts = parts.map((raw: unknown) => ({ raw, legacy: false }));
    if (delta.function_call != null)
      toolParts.push({ raw: { function: delta.function_call }, legacy: true });
    for (const { raw, legacy } of toolParts) {
      const part = record(raw);
      const toolIndex = legacy ? -1 : (part.index ?? 0);
      if (
        typeof toolIndex !== "number" ||
        !Number.isSafeInteger(toolIndex) ||
        toolIndex < (legacy ? -1 : 0) ||
        toolIndex >= 4096
      )
        return fail("invalid_stream_event", "The model service sent an invalid Chat tool index.");
      let tool = state.tools.get(toolIndex);
      if (tool === undefined) {
        if (++toolCount > 4096)
          return fail("stream_limit", "The model service sent too many Chat tool calls.");
        tool = { id: "", name: "", arguments: "" };
        state.tools.set(toolIndex, tool);
      }
      const fn = record(part.function);
      for (const [key, value] of [
        ["id", part.id],
        ["name", fn.name],
      ] as const) {
        if (value == null) continue;
        if (typeof value !== "string" || (value && tool[key] && tool[key] !== value))
          return fail("invalid_stream_event", "The model service changed a Chat tool identity.");
        if (value) {
          toolCharacters += value.length - tool[key].length;
          tool[key] = value;
        }
      }
      if (fn.arguments != null) {
        if (typeof fn.arguments !== "string")
          return fail(
            "invalid_stream_event",
            "The model service sent invalid Chat tool arguments.",
          );
        toolCharacters += fn.arguments.length;
        tool.arguments += fn.arguments;
      }
      if (toolCharacters > 16 * 1024 * 1024)
        return fail("stream_limit", "The model service sent oversized Chat tool arguments.");
    }
    if (choice.finish_reason == null) return;
    if (typeof choice.finish_reason !== "string" || !choice.finish_reason)
      return fail("invalid_stream_event", "The model service sent an invalid Chat finish reason.");
    state.reason = choice.finish_reason;
    reason(state.reason);
    if (incompleteChatReasons.has(state.reason)) return;
    for (const [toolIndex, tool] of state.tools) {
      let argumentsValue: unknown;
      try {
        argumentsValue = JSON.parse(tool.arguments);
      } catch {
        return fail(
          "invalid_stream_event",
          "The model service sent incomplete Chat tool arguments.",
        );
      }
      if (
        !tool.name ||
        (toolIndex !== -1 && !tool.id) ||
        argumentsValue === null ||
        typeof argumentsValue !== "object" ||
        Array.isArray(argumentsValue)
      )
        return fail(
          "invalid_stream_event",
          "The model service sent incomplete Chat tool arguments or identity.",
        );
    }
  };
  return { observe: observeChatChoice, choices: chatChoices };
}
