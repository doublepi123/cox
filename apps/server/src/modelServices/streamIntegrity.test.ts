import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor, ModelServiceStreamError } from "./streamIntegrity.ts";

const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (delta: unknown, finish_reason: string | null = null) =>
  frame({ choices: [{ index: 0, delta, finish_reason }] });
const response = (status: string) =>
  frame({ type: `response.${status}`, response: { status, output: [] } });

describe("model service stream integrity", () => {
  it.each(["\n", "\r\n"])("accepts split UTF-8, delimiters and DONE with %j", (newline) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    const text = (
      chat({ content: "你好" }) +
      chat({}, "stop") +
      frame({ choices: [], usage: { prompt_tokens: 12 } }) +
      "data: [DONE]\n\n"
    ).replaceAll("\n", newline);
    const bytes = encoder.encode(text);
    const frames: string[] = [];
    for (const byte of bytes) frames.push(...monitor.push(Uint8Array.of(byte)));
    monitor.finish();
    monitor.finish();
    expect(frames).toHaveLength(4);
    expect(monitor.snapshot()).toMatchObject({
      bytes: bytes.length,
      frames: 4,
      dataFrames: 4,
      tailLength: 0,
      terminal: "completed",
      terminalEvents: 1,
      doneMarker: true,
      finalized: true,
      finishReasons: ["stop"],
      validationError: undefined,
    });
  });

  it.each(["stop", "tool_calls", "length", "content_filter"])(
    "never substitutes finish_reason=%s for DONE",
    (reason) => {
      const monitor = makeModelServiceStreamMonitor("openai-chat");
      monitor.push(encoder.encode(chat({}, reason)));
      expect(() => monitor.finish()).toThrow(
        expect.objectContaining({ reason: "missing_terminal_event" }),
      );
      expect(() => monitor.finish()).toThrow(ModelServiceStreamError);
      expect(monitor.snapshot()).toMatchObject({ doneMarker: false, terminal: "none" });
    },
  );

  it.each([
    { tail: "data: [DONE]", reason: "incomplete_sse_frame" },
    { tail: "data: [DONE]\n", reason: "incomplete_sse_frame" },
    { tail: 'data: {"choices":', reason: "incomplete_sse_frame" },
    { tail: 'data: {"choices":\n\n', reason: "invalid_json" },
    { tail: "data: []\n\n", reason: "invalid_stream_event" },
  ])("diagnoses malformed tails without leaking their content ($reason)", ({ tail, reason }) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    expect(() => {
      monitor.push(encoder.encode(chat({ content: "private-content" }) + tail));
      monitor.finish();
    }).toThrow(expect.objectContaining({ reason }));
    expect(monitor.snapshot()).toMatchObject({ validationError: reason, doneMarker: false });
    expect(JSON.stringify(monitor.snapshot())).not.toContain("private-content");
  });

  it("diagnoses unterminated SSE even after a legitimate terminal marker", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(encoder.encode(chat({}, "stop") + "data: [DONE]\n\n: tail"));
    expect(() => monitor.finish()).toThrow(
      expect.objectContaining({ reason: "incomplete_sse_frame" }),
    );
    expect(monitor.snapshot()).toMatchObject({ doneMarker: true, tailLength: 6 });
  });

  it.each([Uint8Array.of(0xff), Uint8Array.of(0xe4, 0xbd)])(
    "rejects invalid UTF-8 (%j)",
    (bytes) => {
      const monitor = makeModelServiceStreamMonitor("openai-chat");
      expect(() => {
        monitor.push(bytes);
        monitor.finish();
      }).toThrow(expect.objectContaining({ reason: "invalid_utf8" }));
    },
  );

  it.each(["length", "max_tokens", "content_filter"])(
    "tracks incomplete Chat terminal %s",
    (reason) => {
      const monitor = makeModelServiceStreamMonitor("openai-chat");
      monitor.push(encoder.encode(chat({}, reason) + "data: [DONE]\n\n"));
      monitor.finish();
      expect(monitor.snapshot().terminal).toBe("incomplete");
    },
  );

  it.each(["completed", "incomplete", "failed"])(
    "requires a real Responses terminal event: %s",
    (status) => {
      const monitor = makeModelServiceStreamMonitor("openai-responses");
      monitor.push(encoder.encode(response(status) + "data: [DONE]\n\n"));
      monitor.finish();
      expect(monitor.snapshot()).toMatchObject({ terminal: status, terminalEvents: 1 });
    },
  );

  it.each([
    {
      protocol: "openai-chat",
      text: "data: [DONE]\n\ndata: [DONE]\n\n",
      reason: "duplicate_terminal_event",
    },
    {
      protocol: "openai-chat",
      text: "data: [DONE]\n\n" + chat({ content: "late" }),
      reason: "event_after_terminal",
    },
    { protocol: "openai-responses", text: "data: [DONE]\n\n", reason: "invalid_stream_event" },
    {
      protocol: "openai-responses",
      text: response("completed") + response("completed"),
      reason: "duplicate_terminal_event",
    },
    {
      protocol: "openai-responses",
      text: frame({ type: "response.completed" }),
      reason: "invalid_stream_event",
    },
  ] as const)(
    "rejects invalid terminal sequences ($protocol, $reason)",
    ({ protocol, text, reason }) => {
      const monitor = makeModelServiceStreamMonitor(protocol);
      expect(() => monitor.push(encoder.encode(text))).toThrow(expect.objectContaining({ reason }));
    },
  );

  it("records protocol errors without recording upstream error messages or arbitrary finish reasons", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(
      encoder.encode(chat({}, "private-parameter") + frame({ error: { message: "private-key" } })),
    );
    monitor.finish();
    expect(monitor.snapshot()).toMatchObject({ terminal: "error", finishReasons: ["other"] });
    expect(JSON.stringify(monitor.snapshot())).not.toMatch(/private/);
  });

  it("requires message_stop rather than an Anthropic stop_reason", () => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    monitor.push(
      encoder.encode(frame({ type: "message_delta", delta: { stop_reason: "end_turn" } })),
    );
    expect(() => monitor.finish()).toThrow(
      expect.objectContaining({ reason: "missing_terminal_event" }),
    );
  });

  it("uses Gemini's protocol finishReason instead of inventing a DONE marker", () => {
    const monitor = makeModelServiceStreamMonitor("gemini");
    monitor.push(encoder.encode(frame({ candidates: [{ finishReason: "MAX_TOKENS" }] })));
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });

  it("records Anthropic max_tokens as incomplete even with a legitimate message_stop", () => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    monitor.push(
      encoder.encode(
        frame({ type: "message_delta", delta: { stop_reason: "max_tokens" } }) +
          frame({ type: "message_stop" }),
      ),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });
});
