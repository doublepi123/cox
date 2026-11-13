import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor, ModelServiceStreamError } from "./streamIntegrity.ts";

const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (delta: unknown, finish_reason: string | null = null) =>
  frame({ choices: [{ index: 0, delta, finish_reason }] });
const response = (status: string) =>
  frame({ type: `response.${status}`, response: { status, output: [] } });

describe("model service stream integrity", () => {
  it.each([
    "",
    chat({ content: "private-content" }),
    frame({
      choices: [
        { index: 0, delta: {}, finish_reason: "stop" },
        { index: 1, delta: { content: "private-content" } },
      ],
    }),
  ])("requires a finish reason for every Chat choice before DONE (%s)", (text) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    expect(() => monitor.push(encoder.encode(text + "data: [DONE]\n\n"))).toThrow(
      expect.objectContaining({ reason: "missing_terminal_event" }),
    );
    expect(monitor.snapshot().terminal).toBe("none");
    expect(JSON.stringify(monitor.snapshot())).not.toContain("private-content");
  });

  it.each(['{"private-argument":', "[]", "null", "true", '"text"', ""])(
    "rejects invalid successful tool arguments without exposing them (%s)",
    (argumentsText) => {
      const monitor = makeModelServiceStreamMonitor("openai-chat");
      expect(() =>
        monitor.push(
          encoder.encode(
            chat(
              {
                tool_calls: [
                  { index: 0, id: "call_a", function: { name: "read", arguments: argumentsText } },
                ],
              },
              "tool_calls",
            ),
          ),
        ),
      ).toThrow(expect.objectContaining({ reason: "invalid_stream_event" }));
      expect(monitor.snapshot().terminal).toBe("none");
      expect(JSON.stringify(monitor.snapshot())).not.toContain("private-argument");
    },
  );

  it("validates interleaved fragmented tools independently across choices", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    const tool = (index: number, id: string, name: string, args: string) => ({
      index,
      id,
      function: { name, arguments: args },
    });
    const text =
      frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [tool(0, "call_a", "read", '{"path":'), tool(1, "call_b", "list", "{")],
            },
          },
          {
            index: 1,
            delta: { tool_calls: [tool(0, "call_c", "search", "{}")] },
            finish_reason: "tool_calls",
          },
        ],
      }) +
      chat({ tool_calls: [tool(1, "", "", "}"), tool(0, "", "", '"x"}')] }, "tool_calls") +
      frame({ choices: [], usage: { completion_tokens: 20 } }) +
      "data: [DONE]\n\n";
    for (const byte of encoder.encode(text)) monitor.push(Uint8Array.of(byte));
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("completed");
  });

  it.each(["length", "max_tokens", "content_filter"])(
    "preserves partial tools as incomplete for %s",
    (finish) => {
      const monitor = makeModelServiceStreamMonitor("openai-chat");
      monitor.push(
        encoder.encode(
          chat({ tool_calls: [{ index: 0, function: { arguments: "{" } }] }, finish) +
            frame({ choices: [{ index: 1, delta: {}, finish_reason: "stop" }] }) +
            "data: [DONE]\n\n",
        ),
      );
      monitor.finish();
      expect(monitor.snapshot().terminal).toBe("incomplete");
    },
  );

  it.each([
    chat({ tool_calls: [{ index: 0, function: { name: "read", arguments: "{}" } }] }, "tool_calls"),
    chat({ tool_calls: [{ index: 0, id: "call_a", function: { arguments: "{}" } }] }, "stop"),
    chat({ tool_calls: [{ index: 0, id: "call_a" }] }) +
      chat({ tool_calls: [{ index: 0, id: "call_b" }] }),
    chat({}, "stop") + chat({ content: "late" }),
    chat({ tool_calls: [{ index: -1 }] }),
    chat({ tool_calls: [{ index: 4096 }] }),
    frame({ choices: [{ index: 128, delta: {} }] }),
  ])("rejects malformed choices and tool identities (%s)", (text) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    expect(() => monitor.push(encoder.encode(text))).toThrow(
      expect.objectContaining({ reason: "invalid_stream_event" }),
    );
  });

  it("retains valid legacy function calls on the native Chat path", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(
      encoder.encode(
        chat({ function_call: { name: "read", arguments: "{" } }) +
          chat({ function_call: { arguments: "}" } }, "function_call") +
          "data: [DONE]\n\n",
      ),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("completed");
  });

  it("bounds tool tracking across choices", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(
      encoder.encode(chat({ tool_calls: Array.from({ length: 4096 }, (_, index) => ({ index })) })),
    );
    expect(() =>
      monitor.push(
        encoder.encode(frame({ choices: [{ index: 1, delta: { tool_calls: [{ index: 0 }] } }] })),
      ),
    ).toThrow(expect.objectContaining({ reason: "stream_limit" }));
  });

  it("bounds accumulated arguments even when every frame is below the SSE limit", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    const fragment = encoder.encode(
      chat({ tool_calls: [{ index: 0, function: { arguments: "x".repeat(1024 * 1024) } }] }),
    );
    for (let index = 0; index < 16; index++) monitor.push(fragment);
    expect(() => monitor.push(fragment)).toThrow(
      expect.objectContaining({ reason: "stream_limit" }),
    );
  });
  it("separates protocol completion from an explicitly zero-generated empty stop", () => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(
      encoder.encode(chat({}, "stop") + frame({ choices: [], usage: { completion_tokens: 0 } })),
    );
    expect(monitor.isZeroTokenStop()).toBe(false);
    monitor.push(encoder.encode("data: [DONE]\n\n"));
    monitor.finish();
    expect(monitor.isZeroTokenStop()).toBe(true);
    expect(monitor.snapshot()).toMatchObject({
      terminal: "completed",
      doneMarker: true,
      validationError: undefined,
      output: { outputTokens: 0, textCharacters: 0 },
    });
  });
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
      text: chat({}, "stop") + "data: [DONE]\n\ndata: [DONE]\n\n",
      reason: "duplicate_terminal_event",
    },
    {
      protocol: "openai-chat",
      text: chat({}, "stop") + "data: [DONE]\n\n" + chat({ content: "late" }),
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
