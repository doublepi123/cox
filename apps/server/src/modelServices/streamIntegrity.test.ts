import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor } from "./streamIntegrity.ts";

const encoder = new TextEncoder();
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chat = (delta: unknown, finish_reason: string | null = null) =>
  frame({ choices: [{ index: 0, delta, finish_reason }] });

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
      expect.objectContaining({
        reason: "missing_terminal_event",
        detail: expect.stringContaining("ended without"),
      }),
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
  it.each([
    { name: "stop", head: chat({ content: "hi" }, "stop"), finish: "stop" },
    {
      name: "tool_calls",
      head: chat(
        { tool_calls: [{ index: 0, id: "call_a", function: { name: "read", arguments: "{}" } }] },
        "tool_calls",
      ),
      finish: "tool_calls",
    },
  ])("accepts an OpenRouter usage trailer repeating finish_reason=$name", ({ head, finish }) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(
      encoder.encode(
        head +
          frame({
            choices: [
              { index: 0, delta: { role: "assistant", content: "" }, finish_reason: finish },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }) +
          "data: [DONE]\n\n",
      ),
    );
    monitor.finish();
    expect(monitor.snapshot()).toMatchObject({
      terminal: "completed",
      validationError: undefined,
      output: { outputTokens: 2 },
    });
  });

  it.each([
    { name: "content", text: chat({ content: "more" }) },
    { name: "reasoning", text: chat({ reasoning_content: "more" }) },
    { name: "refusal", text: chat({ refusal: "no" }) },
    {
      name: "tool data",
      text: chat({ tool_calls: [{ index: 0, function: { arguments: "{}" } }] }),
    },
    { name: "a different finish_reason", text: chat({}, "length") },
    { name: "empty-delta different finish_reason", text: chat({ content: "" }, "tool_calls") },
  ])("still rejects a finished Chat choice receiving $name", ({ text }) => {
    const monitor = makeModelServiceStreamMonitor("openai-chat");
    monitor.push(encoder.encode(chat({ content: "hi" }, "stop")));
    expect(() => monitor.push(encoder.encode(text))).toThrow(
      expect.objectContaining({ reason: "invalid_stream_event" }),
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
});
