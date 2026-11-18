import { makeModelServiceSseParser } from "./sse.ts";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function withAnthropicResponseModel(value: unknown, model: string): unknown {
  const message = object(value);
  return message?.type === "message" && typeof message.model === "string"
    ? { ...message, model }
    : value;
}

export function makeAnthropicResponseModelStream(model: string) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const encoder = new TextEncoder();
  const frames = makeModelServiceSseParser("frame");
  const rewrite = (frame: string): string => {
    const newline = frame.endsWith("\r\n\r\n") ? "\r\n" : "\n";
    const lines = frame.split(/\r?\n/u);
    const data = lines.filter((line) => line.startsWith("data:"));
    if (!data.length) return frame;
    let event: Record<string, unknown> | undefined;
    try {
      event = object(JSON.parse(data.map((line) => line.slice(5).replace(/^ /u, "")).join("\n")));
    } catch {
      return frame;
    }
    if (event?.type !== "message_start") return frame;
    const message = withAnthropicResponseModel(event.message, model);
    if (message === event.message) return frame;
    let wroteData = false;
    return lines
      .flatMap((line) => {
        if (!line.startsWith("data:")) return [line];
        if (wroteData) return [];
        wroteData = true;
        return [`data: ${JSON.stringify({ ...event, message })}`];
      })
      .join(newline);
  };
  return {
    push: (chunk: Uint8Array) =>
      encoder.encode(
        frames(decoder.decode(chunk, { stream: true }))
          .map(rewrite)
          .join(""),
      ),
    finish: () => {
      frames(decoder.decode());
      frames.finish();
    },
  };
}
