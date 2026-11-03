import { ModelServiceError } from "@t3tools/contracts";

export function makeModelServiceSseParser() {
  let buffer = "";
  return (chunk: string): ReadonlyArray<string> => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024)
      throw new ModelServiceError({ detail: "The model service sent an oversized stream event." });
    const events: string[] = [];
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""));
      if (data.length) events.push(`data: ${data.join("\n")}`);
    }
    return events;
  };
}
