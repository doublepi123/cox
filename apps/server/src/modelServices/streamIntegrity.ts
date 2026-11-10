import type { ModelServiceProtocol } from "@t3tools/contracts";
import * as Data from "effect/Data";
import { makeModelServiceSseParser } from "./sse.ts";

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

export function makeModelServiceStreamMonitor(protocol: ModelServiceProtocol) {
  const parse = makeModelServiceSseParser();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const reasons = new Set<string>();
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
  const observe = (frame: string) => {
    const data = frame.slice(5).trim();
    if (data === "[DONE]") {
      if (doneMarker)
        return fail("duplicate_terminal_event", "The model service sent duplicate [DONE] markers.");
      doneMarker = true;
      if (protocol === "openai-chat")
        mark(
          [...reasons].some((value) => ["length", "max_tokens", "content_filter"].includes(value))
            ? "incomplete"
            : "completed",
        );
      else if (protocol !== "openai-responses" || terminal === "none")
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
      for (const choice of event.choices) reason(record(choice).finish_reason);
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
    }),
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
