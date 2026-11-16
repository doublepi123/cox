export const streamRecord = (value: unknown): Record<string, unknown> =>
  isStreamObject(value) ? value : {};

export function isStreamObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const streamIndex = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < limit;

export function streamObjectJson(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return isStreamObject(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

export type StreamReject = (detail: string) => never;
