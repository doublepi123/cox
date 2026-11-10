import { ModelServiceError } from "@t3tools/contracts";

export function makeModelServiceSseParser() {
  let buffer = "";
  let frames = 0;
  let dataFrames = 0;
  let finished = false;
  const parse = (chunk: string): ReadonlyArray<string> => {
    if (finished)
      throw new ModelServiceError({ detail: "The model service stream is already finalized." });
    buffer += chunk;
    const events: string[] = [];
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      if (boundary.index > 16 * 1024 * 1024)
        throw new ModelServiceError({
          detail: "The model service sent an oversized stream event.",
        });
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      frames++;
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) {
        dataFrames++;
        events.push(`data: ${data.join("\n")}`);
      }
    }
    if (buffer.length > 16 * 1024 * 1024)
      throw new ModelServiceError({ detail: "The model service sent an oversized stream event." });
    return events;
  };
  return Object.assign(parse, {
    snapshot: () => ({ frames, dataFrames, tailLength: buffer.length }),
    finish: () => {
      finished = true;
      if (/[^\r\n]/.test(buffer))
        throw new ModelServiceError({
          detail: "The model service stream ended with an incomplete SSE frame.",
        });
    },
  });
}
