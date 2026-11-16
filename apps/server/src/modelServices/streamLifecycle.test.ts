import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor } from "./streamIntegrity.ts";
import { modelServiceStreamEvent } from "./responseProgress.ts";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encode = (events: readonly unknown[]) => new TextEncoder().encode(events.map(frame).join(""));
const start = { type: "message_start", message: { content: [] } };
const delta = { type: "message_delta", delta: { stop_reason: "end_turn" } };
const stop = { type: "message_stop" };
const block = (index: number, content_block: unknown) => ({
  type: "content_block_start",
  index,
  content_block,
});
const end = (index: number) => ({ type: "content_block_stop", index });
describe("protocol lifecycle integrity", () => {
  it("commits a Gemini prompt safety block as an incomplete result", () => {
    const event = { promptFeedback: { blockReason: "SAFETY" } };
    expect(modelServiceStreamEvent("gemini", frame(event).trim())).toEqual({ progress: true });
    const monitor = makeModelServiceStreamMonitor("gemini");
    monitor.push(encode([event, { usageMetadata: { totalTokenCount: 1 } }]));
    monitor.finish();
    expect(monitor.snapshot()).toMatchObject({ terminal: "incomplete", finishReasons: ["SAFETY"] });
  });

  it.each([
    [stop],
    [start, stop],
    [start, block(0, { type: "text", text: "hi" }), delta, stop],
    [start, end(0), delta, stop],
    [
      start,
      block(0, { type: "text", text: "" }),
      end(0),
      block(0, { type: "text", text: "" }),
      end(0),
      delta,
      stop,
    ],
    [start, delta, block(0, { type: "text", text: "" }), end(0), stop],
    [
      start,
      block(0, { type: "tool_use", id: "a", name: "read", input: {} }),
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "{" },
      },
      end(0),
      delta,
      stop,
    ],
    [start, block(0, { type: "tool_use", id: "a", name: "read", input: [] }), end(0), delta, stop],
  ])("rejects broken Anthropic message/block lifecycles %#", (...events) => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    expect(() => {
      monitor.push(encode(events));
      monitor.finish();
    }).toThrow(expect.objectContaining({ reason: "invalid_stream_event" }));
  });

  it.each([
    [
      {
        candidates: [
          { index: 0, content: { parts: [{ text: "unfinished" }] } },
          { index: 1, finishReason: "STOP" },
        ],
      },
    ],
    [{ candidates: [{ index: 0 }] }, { candidates: [{ index: 1, finishReason: "SAFETY" }] }],
    [{ candidates: [{ index: -1, finishReason: "STOP" }] }],
    [{ candidates: [{ index: 128, finishReason: "STOP" }] }],
    [
      {
        candidates: [
          {
            index: 0,
            content: { parts: [{ functionCall: { name: "read", args: [] } }] },
            finishReason: "STOP",
          },
        ],
      },
    ],
    [
      { candidates: [{ index: 0, finishReason: "STOP" }] },
      { candidates: [{ index: 0, content: { parts: [{ text: "late" }] } }] },
    ],
  ])("rejects unfinished or invalid Gemini candidates %#", (...events) => {
    const monitor = makeModelServiceStreamMonitor("gemini");
    expect(() => {
      monitor.push(encode(events));
      monitor.finish();
    }).toThrow(expect.objectContaining({ reason: "invalid_stream_event" }));
  });

  it.each(["end_turn", "max_tokens", "refusal"])(
    "accepts Anthropic lifecycle and %s truncation",
    (reason) => {
      const monitor = makeModelServiceStreamMonitor("anthropic-messages");
      monitor.push(
        encode([
          start,
          block(0, { type: "tool_use", id: "a", name: "read", input: {} }),
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: reason === "end_turn" ? "{}" : "{" },
          },
          end(0),
          { type: "message_delta", delta: { stop_reason: reason } },
          stop,
        ]),
      );
      monitor.finish();
      expect(monitor.snapshot().terminal).toBe(reason === "end_turn" ? "completed" : "incomplete");
    },
  );

  it("accepts Gemini independent candidates and accounting trailers", () => {
    const monitor = makeModelServiceStreamMonitor("gemini");
    monitor.push(
      encode([
        {
          candidates: [
            {
              index: 0,
              content: { parts: [{ functionCall: { name: "read", args: {} } }] },
              finishReason: "STOP",
            },
            { index: 1, finishReason: "MAX_TOKENS" },
          ],
        },
        { usageMetadata: { totalTokenCount: 10 } },
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });

  it.each(["MAX_TOKENS", "SAFETY"])("preserves Gemini %s with partial tool output", (reason) => {
    const monitor = makeModelServiceStreamMonitor("gemini");
    monitor.push(
      encode([
        {
          candidates: [
            { content: { parts: [{ functionCall: { args: [] } }] }, finishReason: reason },
          ],
        },
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });

  it("accepts Gemini tool calls with omitted optional args", () => {
    const monitor = makeModelServiceStreamMonitor("gemini");
    monitor.push(
      encode([
        {
          candidates: [
            { content: { parts: [{ functionCall: { name: "read" } }] }, finishReason: "STOP" },
          ],
        },
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("completed");
  });
});
