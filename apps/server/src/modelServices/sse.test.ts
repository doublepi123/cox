import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceSseParser } from "./sse.ts";

describe("model gateway SSE framing", () => {
  it("preserves event boundaries across chunks and CRLF, joining multiline data", () => {
    const parse = makeModelServiceSseParser();
    expect(parse(': keepalive\r\nevent: delta\r\ndata: {"text":')).toEqual([]);
    expect(parse('"hello"}\r\ndata: second line\r\n\r')).toEqual([]);
    expect(parse("\ndata: [DONE]\n\n")).toEqual([
      'data: {"text":"hello"}\nsecond line',
      "data: [DONE]",
    ]);
  });

  it("rejects oversized unbounded events", () => {
    expect(() => makeModelServiceSseParser()("x".repeat(16 * 1024 * 1024 + 1))).toThrow(
      "oversized stream event",
    );
  });

  it("finalizes only fully delimited events and keeps metadata about the tail", () => {
    const parse = makeModelServiceSseParser();
    expect(parse(': heartbeat\n\ndata: {"ok":true}\n\ndata: [DONE]\n')).toEqual([
      'data: {"ok":true}',
    ]);
    expect(parse.snapshot()).toEqual({ frames: 2, dataFrames: 1, tailLength: 13 });
    expect(() => parse.finish()).toThrow("incomplete SSE frame");
    expect(() => parse("\n")).toThrow("already finalized");
  });

  it.each(["data: [DONE]", 'data: {"text":', "data: ", ": heartbeat\n", "event: done\n"])(
    "does not promote an EOF tail to a dispatched event (%s)",
    (tail) => {
      const parse = makeModelServiceSseParser();
      expect(parse(tail)).toEqual([]);
      expect(() => parse.finish()).toThrow("incomplete SSE frame");
      expect(parse.snapshot().dataFrames).toBe(0);
    },
  );

  it("accepts empty trailing line breaks and idempotent finalization", () => {
    const parse = makeModelServiceSseParser();
    parse("data: [DONE]\r\n\r\n\n");
    expect(() => parse.finish()).not.toThrow();
    expect(() => parse.finish()).not.toThrow();
    expect(parse.snapshot().dataFrames).toBe(1);
  });

  it("limits individual events rather than the total size of a network chunk", () => {
    const parse = makeModelServiceSseParser();
    const frame = `data: ${"x".repeat(8 * 1024 * 1024)}\n\n`;
    expect(parse(frame + frame)).toHaveLength(2);
    expect(() => parse.finish()).not.toThrow();
  });
});
