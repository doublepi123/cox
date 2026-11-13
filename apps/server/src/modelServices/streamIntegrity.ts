import type { ModelServiceProtocol } from "@t3tools/contracts";
import * as Data from "effect/Data";
import { makeModelServiceSseParser } from "./sse.ts";
import { makeChatOutputTracker } from "./responseOutput.ts";

export class ModelServiceStreamError extends Data.TaggedError("ModelServiceStreamError")<{
  readonly reason:
    | "incomplete_sse_frame"
    | "invalid_json"
    | "invalid_utf8"
    | "invalid_stream_event"
    | "missing_terminal_event"
    | "duplicate_terminal_event"
    | "event_after_terminal"
    | "stream_limit";
  readonly detail: string;
}> {}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const finishReasons = new Set([
  "stop",
  "tool_calls",
  "function_call",
  "length",
  "max_tokens",
  "content_filter",
  "end_turn",
  "stop_sequence",
  "pause_turn",
  "refusal",
  "STOP",
  "MAX_TOKENS",
  "SAFETY",
  "RECITATION",
  "OTHER",
  "BLOCKLIST",
  "PROHIBITED_CONTENT",
  "SPII",
  "MALFORMED_FUNCTION_CALL",
  "max_output_tokens",
]);
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

export function makeModelServiceStreamMonitor(protocol: ModelServiceProtocol) {
  const parse = makeModelServiceSseParser();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const output = protocol === "openai-chat" ? makeChatOutputTracker() : undefined;
  const reasons = new Set<string>();
  const chatChoices = new Map<number, ChatStreamChoice>();
  let toolCount = 0;
  let toolCharacters = 0;
  let bytes = 0;
  let terminal: "none" | "completed" | "incomplete" | "failed" | "error" = "none";
  let terminalEvents = 0;
  let doneMarker = false;
  let finished = false;
  let failure: ModelServiceStreamError | undefined;
  const fail = (reason: ModelServiceStreamError["reason"], detail: string): never => {
    failure = new ModelServiceStreamError({ reason, detail });
    throw failure;
  };
  const mark = (state: typeof terminal) => {
    terminalEvents++;
    if (terminal !== "none")
      fail("duplicate_terminal_event", "The model service sent duplicate terminal events.");
    terminal = state;
  };
  const reason = (value: unknown) => {
    if (typeof value === "string" && value.length)
      reasons.add(finishReasons.has(value) ? value : "other");
  };
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
  const observe = (frame: string) => {
    const data = frame.slice(5).trim();
    if (data === "[DONE]") {
      if (doneMarker)
        return fail("duplicate_terminal_event", "The model service sent duplicate [DONE] markers.");
      doneMarker = true;
      if (protocol === "openai-chat") {
        if (
          chatChoices.size === 0 ||
          [...chatChoices.values()].some((choice) => choice.reason === null)
        )
          return fail(
            "missing_terminal_event",
            "The model service ended before every Chat choice finished.",
          );
        mark(
          [...reasons].some((value) => incompleteChatReasons.has(value))
            ? "incomplete"
            : "completed",
        );
      } else if (protocol !== "openai-responses" || terminal === "none")
        return fail("invalid_stream_event", "The model service sent an unexpected [DONE] marker.");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return fail("invalid_json", "The model service sent invalid JSON in a stream event.");
    }
    const event = record(value);
    if (!Object.keys(event).length)
      return fail("invalid_stream_event", "The model service sent an invalid stream event.");
    if (event.error || event.type === "error") {
      mark("error");
      return;
    }
    const terminalType =
      protocol === "openai-responses"
        ? ["response.completed", "response.incomplete", "response.failed"].includes(
            String(event.type),
          )
        : protocol === "anthropic-messages" && event.type === "message_stop";
    if (terminal !== "none" && !terminalType)
      return fail("event_after_terminal", "The model service sent data after its terminal event.");
    if (protocol === "openai-chat") {
      if (!Array.isArray(event.choices))
        return fail("invalid_stream_event", "The model service sent an invalid Chat stream event.");
      for (const choice of event.choices) observeChatChoice(choice);
      output?.observe(event);
    } else if (protocol === "openai-responses") {
      const state =
        event.type === "response.completed"
          ? "completed"
          : event.type === "response.incomplete"
            ? "incomplete"
            : event.type === "response.failed"
              ? "failed"
              : undefined;
      if (state) {
        const response = record(event.response);
        if (state !== "failed" && (response.status !== state || !Array.isArray(response.output)))
          return fail(
            "invalid_stream_event",
            "The model service sent an invalid Responses terminal event.",
          );
        reason(record(response.incomplete_details).reason);
        mark(state);
      }
    } else if (protocol === "anthropic-messages") {
      reason(record(event.delta).stop_reason);
      if (event.type === "message_stop")
        mark(
          [...reasons].some((value) => ["max_tokens", "refusal"].includes(value))
            ? "incomplete"
            : "completed",
        );
    } else {
      const candidates = Array.isArray(event.candidates) ? event.candidates : [];
      for (const candidate of candidates) reason(record(candidate).finishReason);
      if (record(event.promptFeedback).blockReason) reason("SAFETY");
    }
  };
  const push = (chunk: Uint8Array): ReadonlyArray<string> => {
    if (failure) throw failure;
    if (finished)
      return fail("event_after_terminal", "The model service stream is already finalized.");
    bytes += chunk.length;
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: true });
    } catch {
      return fail("invalid_utf8", "The model service stream contains invalid UTF-8.");
    }
    let frames: ReadonlyArray<string>;
    try {
      frames = parse(text);
    } catch {
      return fail("stream_limit", "The model service sent an oversized stream event.");
    }
    for (const frame of frames) observe(frame);
    return frames;
  };
  return {
    push,
    snapshot: () => ({
      ...parse.snapshot(),
      bytes,
      terminal,
      terminalEvents,
      doneMarker,
      finishReasons: [...reasons],
      finalized: finished,
      validationError: failure?.reason,
      output: output?.snapshot(),
    }),
    isZeroTokenStop: () =>
      terminal === "completed" && doneMarker && output?.isZeroTokenStop() === true,
    finish: () => {
      if (failure) throw failure;
      if (finished) return;
      finished = true;
      let tail: string;
      try {
        tail = decoder.decode();
      } catch {
        return fail("invalid_utf8", "The model service stream ended inside a UTF-8 character.");
      }
      for (const frame of parse(tail)) observe(frame);
      try {
        parse.finish();
      } catch {
        return fail(
          "incomplete_sse_frame",
          "The model service stream ended with an incomplete SSE frame.",
        );
      }
      if (protocol === "gemini" && terminal === "none" && reasons.size)
        mark([...reasons].every((value) => value === "STOP") ? "completed" : "incomplete");
      if (terminal === "none")
        fail("missing_terminal_event", "The model service stream ended before its terminal event.");
    },
  };
}
