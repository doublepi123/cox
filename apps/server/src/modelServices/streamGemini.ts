import { isStreamObject, streamIndex, streamRecord, type StreamReject } from "./streamValues.ts";

export function makeGeminiStreamTracker(reject: StreamReject) {
  const candidates = new Map<
    number,
    { readonly reason: string | null; readonly validTools: boolean }
  >();
  let blocked = false;
  return {
    observe(event: Record<string, unknown>) {
      const blockReason = streamRecord(event.promptFeedback).blockReason;
      if (blockReason != null && (typeof blockReason !== "string" || !blockReason))
        reject("The model service sent an invalid Gemini prompt block reason.");
      if (typeof blockReason === "string" && blockReason) blocked = true;
      if (event.candidates != null && !Array.isArray(event.candidates))
        reject("The model service sent invalid Gemini candidates.");
      const values = Array.isArray(event.candidates) ? event.candidates : [];
      const seen = new Set<number>();
      for (const value of values) {
        const candidate = streamRecord(value);
        const index = candidate.index ?? 0;
        if (!streamIndex(index, 128) || seen.has(index))
          return reject("The model service sent an invalid Gemini candidate index.");
        seen.add(index);
        const previous = candidates.get(index);
        const parts = streamRecord(candidate.content).parts;
        if (parts != null && !Array.isArray(parts))
          reject("The model service sent invalid Gemini content parts.");
        const content = Array.isArray(parts) ? parts : [];
        if (previous?.reason != null) {
          if (
            content.length ||
            (candidate.finishReason != null && candidate.finishReason !== previous.reason)
          )
            reject("The model service continued a finished Gemini candidate.");
          continue;
        }
        let validTools = previous?.validTools ?? true;
        for (const value of content) {
          const part = streamRecord(value);
          if (part.functionCall == null) continue;
          const call = streamRecord(part.functionCall);
          validTools &&=
            typeof call.name === "string" &&
            Boolean(call.name) &&
            (!("args" in call) || isStreamObject(call.args));
        }
        const finish = candidate.finishReason;
        if (finish != null && (typeof finish !== "string" || !finish || finish.length > 128))
          reject("The model service sent an invalid Gemini finish reason.");
        if (finish === "STOP" && !validTools)
          reject("The model service sent invalid Gemini tool arguments or identity.");
        candidates.set(index, { reason: typeof finish === "string" ? finish : null, validTools });
      }
    },
    finish(): "completed" | "incomplete" {
      if ([...candidates.values()].some((candidate) => candidate.reason === null))
        reject("The model service stream ended without finishing every Gemini candidate.");
      if (!candidates.size && !blocked)
        reject("The model service stream ended without its Gemini terminal event.");
      return blocked || [...candidates.values()].some((candidate) => candidate.reason !== "STOP")
        ? "incomplete"
        : "completed";
    },
  };
}
