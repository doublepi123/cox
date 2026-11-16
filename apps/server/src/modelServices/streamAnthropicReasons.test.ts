import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor } from "./streamIntegrity.ts";

const encode = (events: readonly unknown[]) =>
  new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
const events = (reason: unknown) => [
  { type: "message_start", message: { content: [] } },
  { type: "message_delta", delta: { stop_reason: reason } },
  { type: "message_stop" },
];

describe("Anthropic terminal reason classification", () => {
  it.each([
    ["end_turn", "completed"],
    ["stop_sequence", "completed"],
    ["tool_use", "completed"],
    ["pause_turn", "completed"],
    ["max_tokens", "incomplete"],
    ["refusal", "incomplete"],
    ["model_context_window_exceeded", "incomplete"],
  ])("classifies documented stop reason %s as %s", (reason, terminal) => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    monitor.push(encode(events(reason)));
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe(terminal);
    expect(monitor.snapshot().finishReasons).toEqual([reason]);
  });

  it.each(["unknown_reason", "stop", "END_TURN", 7])("rejects invalid stop reason %s", (reason) => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    expect(() => {
      monitor.push(encode(events(reason)));
      monitor.finish();
    }).toThrow(expect.objectContaining({ reason: "invalid_stream_event" }));
    expect(monitor.snapshot().terminal).toBe("none");
  });

  it("preserves a partial tool at the model context boundary", () => {
    const monitor = makeModelServiceStreamMonitor("anthropic-messages");
    monitor.push(
      encode([
        events("end_turn")[0],
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "a", name: "read", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: "{" },
        },
        { type: "content_block_stop", index: 0 },
        ...events("model_context_window_exceeded").slice(1),
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });
});
