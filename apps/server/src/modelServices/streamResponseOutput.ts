import { streamIndex, streamRecord, type StreamReject } from "./streamValues.ts";

interface Content {
  readonly outputIndex: number;
  readonly index: number;
  readonly field: "text" | "refusal";
  readonly source: "content" | "summary";
  text: string;
  done: boolean;
  valid: boolean;
  deltaSeen: boolean;
}

export function responseOutputFingerprint(value: unknown): string {
  const item = streamRecord(value);
  const parts = (values: unknown) =>
    Array.isArray(values)
      ? values.map((value) => {
          const part = streamRecord(value);
          return [part.type, part.text, part.refusal];
        })
      : values;
  return JSON.stringify([
    item.type,
    item.name,
    item.call_id,
    item.arguments,
    item.input,
    parts(item.content),
    parts(item.summary),
  ]);
}

export function makeResponseContentTracker(reject: StreamReject) {
  const content = new Map<string, Content>();
  let characters = 0;
  return {
    observe(event: Record<string, unknown>, outputIndex: number) {
      const type = event.type;
      if (
        typeof type !== "string" ||
        !/^response\.(output_text|refusal|reasoning_text|reasoning_summary_text)\.(delta|done)$/.test(
          type,
        )
      )
        return;
      const field = type.startsWith("response.refusal.") ? "refusal" : "text";
      const source = type.startsWith("response.reasoning_summary_text.") ? "summary" : "content";
      const index = source === "summary" ? event.summary_index : event.content_index;
      if (!streamIndex(index, 4096))
        return reject("The model service sent an invalid Responses content index.");
      const key = `${outputIndex}:${source}:${index}:${field}`;
      const part = content.get(key) ?? {
        outputIndex,
        index,
        field,
        source,
        text: "",
        done: false,
        valid: true,
        deltaSeen: false,
      };
      if (part.done) reject("The model service continued finished Responses content.");
      if (!content.has(key) && content.size >= 4096)
        reject("The model service sent too many Responses content parts.");
      content.set(key, part);
      if (type.endsWith(".delta")) {
        if (typeof event.delta !== "string")
          return reject("The model service sent an invalid Responses content delta.");
        characters += event.delta.length;
        if (characters > 16 * 1024 * 1024)
          reject("The model service sent oversized Responses content.");
        part.text += event.delta;
        part.deltaSeen = true;
      } else {
        const value = event[field];
        if (!part.deltaSeen && typeof value === "string") {
          characters += value.length;
          if (characters > 16 * 1024 * 1024)
            reject("The model service sent oversized Responses content.");
          part.text = value;
        }
        part.valid = typeof value === "string" && value === part.text;
        part.done = true;
      }
    },
    matches(outputIndex: number, value: unknown): boolean {
      const item = streamRecord(value);
      for (const part of content.values()) {
        if (part.outputIndex !== outputIndex) continue;
        const values = item[part.source];
        const text = Array.isArray(values)
          ? streamRecord(values[part.index])[part.field]
          : undefined;
        if (!part.valid || typeof text !== "string" || text !== part.text) return false;
      }
      return true;
    },
  };
}
