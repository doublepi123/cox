import { describe, expect, it } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeTimeLabel,
} from "./timestampFormat";

describe("localized timestamps", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("keeps English defaults and localizes compact and full relative labels", () => {
    const earlier = "2026-11-01T11:57:00Z";
    expect(formatRelativeTimeLabel(earlier, now)).toBe("3m ago");
    expect(formatRelativeTimeLabel(earlier, now, "zh")).toBe("3分钟前");
    expect(formatRelativeTimeLabel(earlier, now, "zh", true)).toBe("3分钟");
    expect(formatRelativeTimeLabel(new Date(now).toISOString(), now, "zh", true)).toBe("刚刚");
    expect(formatRelativeTimeLabel("invalid", now, "zh")).toBe("");
  });

  it("localizes yesterday and tooltip dates without changing English defaults", () => {
    const yesterday = new Date(2026, 9, 31, 12).toISOString();
    const today = new Date(2026, 10, 1, 12).getTime();
    expect(formatDayAwareTimestamp(yesterday, "24-hour", today, "zh")).toContain("昨天");
    expect(formatDayAwareTimestamp(yesterday, "24-hour", today)).toContain("yesterday");
    expect(formatChatTimestampTooltip(yesterday, "24-hour", "zh")).toContain("2026年10月31日");
    expect(formatChatTimestampTooltip(yesterday, "24-hour")).toContain("31st October 2026");
  });
});
