import { describe, expect, it } from "vite-plus/test";
import { subagentDetailPreview } from "./subagentDisplay.ts";

describe("subagent detail preview", () => {
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
