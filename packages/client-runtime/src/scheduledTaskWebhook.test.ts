import { MAX_WEBHOOK_FILTERS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { parseWebhookFilterDrafts, type WebhookFilterDraft } from "./scheduledTaskWebhook.js";

describe("parseWebhookFilterDrafts", () => {
  it("keeps valid payload values and paths unchanged", () => {
    expect(
      parseWebhookFilterDrafts([
        { id: "filter", path: "body.action", op: "equals", value: "opened" },
      ]),
    ).toEqual({ filters: [{ path: "body.action", op: "equals", value: "opened" }] });
  });

  it("preserves the default English error for non-UI callers", () => {
    expect(parseWebhookFilterDrafts([{ id: "filter", path: "", op: "equals", value: "" }])).toEqual(
      { error: "Filter 1 needs a path under body, headers or query, and a value." },
    );
  });

  it.each(["exists", "in", "equals"] as const)(
    "formats invalid %s filters using structured details",
    (op) => {
      const formatError = vi.fn(() => "本地化筛选错误");
      expect(
        parseWebhookFilterDrafts([{ id: "filter", path: "", op, value: "" }], formatError),
      ).toEqual({ error: "本地化筛选错误" });
      expect(formatError).toHaveBeenCalledWith({ kind: "invalid", row: 1, op });
    },
  );

  it("formats the filter limit without exposing a generated English sentence", () => {
    const drafts: WebhookFilterDraft[] = Array.from(
      { length: MAX_WEBHOOK_FILTERS + 1 },
      (_, index) => ({
        id: `filter-${index}`,
        path: "body.action",
        op: "exists",
        value: "",
      }),
    );
    const formatError = vi.fn(() => "筛选条件过多");
    expect(parseWebhookFilterDrafts(drafts, formatError)).toEqual({ error: "筛选条件过多" });
    expect(formatError).toHaveBeenCalledWith({ kind: "too-many", maximum: MAX_WEBHOOK_FILTERS });
  });
});
