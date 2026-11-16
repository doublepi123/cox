import { streamIndex, streamObjectJson, streamRecord, type StreamReject } from "./streamValues.ts";
import { makeResponseContentTracker, responseOutputFingerprint } from "./streamResponseOutput.ts";

interface Item {
  done: boolean;
  arguments: string;
  argumentsDone: boolean;
  argumentDelta: boolean;
  valid: boolean;
  added: boolean;
  fingerprint: string | undefined;
}

export function makeResponsesStreamTracker(reject: StreamReject) {
  const items = new Map<number, Item>();
  let bytes = 0;
  const content = makeResponseContentTracker(reject);
  const validItem = (value: unknown): boolean => {
    const item = streamRecord(value);
    if (typeof item.type !== "string" || !item.type) return false;
    if (item.status != null && item.status !== "completed") return false;
    if (
      item.type === "function_call" &&
      (typeof item.name !== "string" ||
        !item.name ||
        typeof item.call_id !== "string" ||
        !item.call_id ||
        !streamObjectJson(item.arguments))
    )
      return false;
    if (
      item.type === "custom_tool_call" &&
      (typeof item.name !== "string" ||
        !item.name ||
        typeof item.call_id !== "string" ||
        !item.call_id ||
        typeof item.input !== "string")
    )
      return false;
    const content = Array.isArray(item.content) ? item.content : [];
    for (const value of content) {
      const part = streamRecord(value);
      if (part.status != null && part.status !== "completed") return false;
    }
    return true;
  };
  return {
    observe(event: Record<string, unknown>) {
      const type = event.type;
      if (
        [
          "response.output_item.added",
          "response.output_item.done",
          "response.function_call_arguments.delta",
          "response.function_call_arguments.done",
        ].includes(String(type)) ||
        (typeof type === "string" &&
          type.startsWith("response.") &&
          (event.output_index !== undefined ||
            type.endsWith(".delta") ||
            type.startsWith("response.content_part.") ||
            type.startsWith("response.reasoning_summary_part.")))
      ) {
        const index = event.output_index;
        if (!streamIndex(index, 4096))
          return reject("The model service sent an invalid Responses output index.");
        const item = items.get(index) ?? {
          done: false,
          arguments: "",
          argumentsDone: false,
          argumentDelta: false,
          valid: true,
          added: false,
          fingerprint: undefined,
        };
        if (item.done) reject("The model service continued a finished Responses output item.");
        items.set(index, item);
        content.observe(event, index);
        switch (type) {
          case "response.output_item.added":
            if (item.added) reject("The model service duplicated a Responses output item.");
            item.added = true;
            return;
          case "response.function_call_arguments.delta":
            if (item.argumentsDone || typeof event.delta !== "string")
              return reject("The model service sent invalid Responses tool argument deltas.");
            bytes += event.delta.length;
            if (bytes > 16 * 1024 * 1024)
              reject("The model service sent oversized Responses tool arguments.");
            item.arguments += event.delta;
            item.argumentDelta = true;
            return;
          case "response.function_call_arguments.done":
            if (item.argumentsDone)
              reject("The model service duplicated Responses tool argument completion.");
            item.valid &&=
              streamObjectJson(event.arguments) &&
              (!item.argumentDelta || event.arguments === item.arguments);
            item.argumentsDone = true;
            return;
          case "response.output_item.done":
            item.valid &&=
              !item.argumentDelta ||
              (streamObjectJson(item.arguments) &&
                item.arguments === streamRecord(event.item).arguments);
            item.valid &&= validItem(event.item);
            const fingerprint = responseOutputFingerprint(event.item);
            bytes += fingerprint.length;
            if (bytes > 16 * 1024 * 1024)
              reject("The model service sent oversized Responses output state.");
            item.fingerprint = fingerprint;
            item.done = true;
            return;
          default:
            return;
        }
      }
      if (type !== "response.completed") return;
      const output = streamRecord(event.response).output;
      if (!Array.isArray(output))
        return reject("The model service completed invalid Responses output.");
      for (const item of output) {
        if (!validItem(item))
          reject("The model service completed invalid or unfinished Responses output.");
      }
      for (const [index, item] of items) {
        if (
          !item.done ||
          !item.valid ||
          index >= output.length ||
          item.fingerprint !== responseOutputFingerprint(output[index]) ||
          !content.matches(index, output[index]) ||
          (item.argumentDelta &&
            (!streamObjectJson(item.arguments) ||
              item.arguments !== streamRecord(output[index]).arguments))
        )
          reject("The model service completed unfinished Responses output.");
      }
    },
  };
}
