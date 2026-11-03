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
});
