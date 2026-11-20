import { describe, expect, it } from "vite-plus/test";
import { subagentDetailPreview } from "./subagentDisplay.ts";

describe("subagent detail preview", () => {
  it("clips after compacting whitespace and falls back from a blank result", () => {
    const prefix = "x".repeat(278);
    expect(
      subagentDetailPreview({
        status: "completed",
        result: " \n\t ",
        progress: prefix + "\n".repeat(500) + "a" + "b".repeat(10_000),
      }),
    ).toBe(prefix + " a…");
    expect(subagentDetailPreview({ status: "running", progress: prefix + "xx\n\t " })).toBe(
      prefix + "xx",
    );
  });

  it("preserves surrogate pairs at the preview boundary", () => {
    const prefix = "x".repeat(279);
    expect(subagentDetailPreview({ status: "running", progress: `${prefix}🙂 tail` })).toBe(
      `${prefix}…`,
    );
    expect(subagentDetailPreview({ status: "completed", result: "  hello\nworld  " })).toBe(
      "hello world",
    );
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});
