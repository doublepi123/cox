import {
  isStreamObject,
  streamIndex,
  streamObjectJson,
  streamRecord,
  type StreamReject,
} from "./streamValues.ts";

export const incompleteAnthropicReasons = new Set([
  "max_tokens",
  "refusal",
  "model_context_window_exceeded",
]);
const anthropicStopReasons = new Set([
  "end_turn",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  ...incompleteAnthropicReasons,
]);

interface Block {
  readonly type: string;
  readonly validInput: boolean;
  readonly validIdentity: boolean;
  arguments: string;
  fragmented: boolean;
  stopped: boolean;
}

export function makeAnthropicStreamTracker(reject: StreamReject) {
  const blocks = new Map<number, Block>();
  let started = false;
  let stopReason: string | undefined;
  let bytes = 0;
  const validateTools = () => {
    if (stopReason !== undefined && incompleteAnthropicReasons.has(stopReason)) return;
    for (const block of blocks.values()) {
      if (block.type !== "tool_use" && block.type !== "server_tool_use") continue;
      if (
        !block.validIdentity ||
        !(block.fragmented ? streamObjectJson(block.arguments) : block.validInput)
      )
        reject("The model service sent incomplete Anthropic tool arguments or identity.");
    }
  };
  return {
    observe(event: Record<string, unknown>) {
      const type = event.type;
      if (type === "ping") return;
      if (type === "message_start") {
        if (started) reject("The model service sent duplicate Anthropic message starts.");
        if (
          !isStreamObject(event.message) ||
          !Array.isArray(event.message.content) ||
          event.message.content.length
        )
          reject("The model service sent an invalid Anthropic message start.");
        started = true;
        return;
      }
      if (!started) {
        reject("The model service sent Anthropic data before message_start.");
      }
      switch (type) {
        case "content_block_start": {
          const index = event.index;
          if (
            stopReason ||
            !streamIndex(index, 4096) ||
            index !== blocks.size ||
            [...blocks.values()].some((block) => !block.stopped)
          )
            return reject("The model service sent a misordered Anthropic block start.");
          const block = streamRecord(event.content_block);
          if (typeof block.type !== "string")
            return reject("The model service sent an invalid Anthropic content block.");
          blocks.set(index, {
            type: ["tool_use", "server_tool_use", "text", "thinking"].includes(block.type)
              ? block.type
              : "other",
            validInput: isStreamObject(block.input),
            validIdentity:
              typeof block.id === "string" &&
              Boolean(block.id) &&
              typeof block.name === "string" &&
              Boolean(block.name),
            arguments: "",
            fragmented: false,
            stopped: false,
          });
          return;
        }
        case "content_block_delta":
        case "content_block_stop": {
          const index = event.index;
          const block = typeof index === "number" ? blocks.get(index) : undefined;
          if (stopReason || !block || block.stopped)
            return reject("The model service sent a misordered Anthropic content block event.");
          if (type === "content_block_stop") {
            block.stopped = true;
            return;
          }
          const delta = streamRecord(event.delta);
          if (delta.type === "input_json_delta") {
            if (
              !["tool_use", "server_tool_use"].includes(block.type) ||
              typeof delta.partial_json !== "string"
            )
              return reject("The model service sent invalid Anthropic tool input.");
            bytes += delta.partial_json.length;
            if (bytes > 16 * 1024 * 1024)
              reject("The model service sent oversized Anthropic tool input.");
            block.fragmented = true;
            block.arguments += delta.partial_json;
          } else if (
            (delta.type === "text_delta" && block.type !== "text") ||
            (["thinking_delta", "signature_delta"].includes(String(delta.type)) &&
              block.type !== "thinking")
          )
            reject("The model service sent a mismatched Anthropic content delta.");
          return;
        }
        case "message_delta": {
          if ([...blocks.values()].some((block) => !block.stopped))
            reject("The model service ended a message with an open Anthropic block.");
          const reason = streamRecord(event.delta).stop_reason;
          if (reason != null) {
            if (stopReason || typeof reason !== "string" || !anthropicStopReasons.has(reason))
              return reject("The model service sent an invalid Anthropic stop reason.");
            stopReason = reason;
          }
          return;
        }
        case "message_stop":
          if (!stopReason || [...blocks.values()].some((block) => !block.stopped))
            reject("The model service ended without an Anthropic stop delta or block stop.");
          validateTools();
          return;
        default:
          return;
      }
    },
  };
}
