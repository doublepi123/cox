import { describe, expect, it } from "vite-plus/test";
import { makeModelServiceStreamMonitor } from "./streamIntegrity.ts";

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const encode = (events: readonly unknown[]) => new TextEncoder().encode(events.map(frame).join(""));
const completed = (output: readonly unknown[]) => ({
  type: "response.completed",
  response: { status: "completed", output },
});

describe("Responses output and snapshot integrity", () => {
  it.each([
    [completed([{ type: "message", status: "in_progress", content: [] }])],
    [
      completed([
        { type: "function_call", status: "completed", call_id: "a", name: "read", arguments: "{" },
      ]),
    ],
    [
      completed([
        { type: "function_call", status: "completed", call_id: "a", name: "read", arguments: "[]" },
      ]),
    ],
    [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { id: "a", type: "message", status: "in_progress" },
      },
      completed([]),
    ],
    [
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{" },
      completed([
        { type: "function_call", status: "completed", call_id: "a", name: "read", arguments: "{}" },
      ]),
    ],
    [
      {
        type: "response.output_text.delta",
        output_index: 0,
        content_index: 0,
        delta: "unfinished",
      },
      completed([]),
    ],
    [
      { type: "response.refusal.delta", output_index: 0, content_index: 0, delta: "unfinished" },
      completed([]),
    ],
    [
      {
        type: "response.reasoning_summary_text.delta",
        output_index: 0,
        summary_index: 0,
        delta: "unfinished",
      },
      completed([]),
    ],
    [{ type: "response.output_text.delta", delta: "missing index" }, completed([])],
    [
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "original" },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", content: [{ type: "output_text", text: "changed" }] },
      },
      completed([{ type: "message", content: [{ type: "output_text", text: "changed" }] }]),
    ],
    [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "message", content: [{ type: "output_text", text: "original" }] },
      },
      completed([{ type: "message", content: [{ type: "output_text", text: "changed" }] }]),
    ],
  ])("rejects unfinished Responses output %#", (...events) => {
    const monitor = makeModelServiceStreamMonitor("openai-responses");
    expect(() => {
      monitor.push(encode(events));
      monitor.finish();
    }).toThrow(expect.objectContaining({ reason: "invalid_stream_event" }));
  });

  it("accepts real Responses completion without inventing mandatory delta events", () => {
    const monitor = makeModelServiceStreamMonitor("openai-responses");
    monitor.push(
      encode([
        completed([
          {
            type: "function_call",
            status: "completed",
            call_id: "a",
            name: "read",
            arguments: "{}",
          },
        ]),
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("completed");
  });

  it("accepts consistent Responses text, refusal and reasoning snapshots", () => {
    for (const [type, field, source] of [
      ["output_text", "text", "content"],
      ["refusal", "refusal", "content"],
      ["reasoning_summary_text", "text", "summary"],
    ] as const) {
      const monitor = makeModelServiceStreamMonitor("openai-responses");
      const item = {
        type: source === "summary" ? "reasoning" : "message",
        [source]: [{ type, [field]: "answer" }],
      };
      monitor.push(
        encode([
          {
            type: `response.${type}.delta`,
            output_index: 0,
            content_index: 0,
            summary_index: 0,
            delta: "answer",
          },
          {
            type: `response.${type}.done`,
            output_index: 0,
            content_index: 0,
            summary_index: 0,
            [field]: "answer",
          },
          { type: "response.output_item.done", output_index: 0, item },
          completed([item]),
        ]),
      );
      monitor.finish();
      expect(monitor.snapshot().terminal).toBe("completed");
    }
  });

  it("retains Responses incomplete tool output after normal item lifecycle", () => {
    const monitor = makeModelServiceStreamMonitor("openai-responses");
    const item = {
      type: "function_call",
      status: "incomplete",
      name: "read",
      call_id: "a",
      arguments: "{",
    };
    monitor.push(
      encode([
        { type: "response.output_item.added", output_index: 0, item },
        { type: "response.output_item.done", output_index: 0, item },
        { type: "response.incomplete", response: { status: "incomplete", output: [item] } },
      ]),
    );
    monitor.finish();
    expect(monitor.snapshot().terminal).toBe("incomplete");
  });
});
