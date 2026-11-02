import { describe, expect, it } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeElapsed,
  formatRelativeTimeLabel,
} from "./timestampFormat";
import { translate } from "./i18n/language";

describe("localized timestamps", () => {
  const now = Date.parse("2026-11-01T12:00:00Z");

  it("localizes reactive elapsed values and the provider last-checked template", () => {
    expect(formatRelativeElapsed(0, "zh")).toEqual({ value: "刚刚", suffix: null });
    expect(formatRelativeElapsed(180_000, "zh")).toEqual({ value: "3分钟", suffix: "ago" });
    expect(formatRelativeElapsed(10_800_000, "zh")).toEqual({ value: "3小时", suffix: "ago" });
    expect(formatRelativeElapsed(172_800_000, "zh")).toEqual({ value: "2天", suffix: "ago" });
    expect(formatRelativeElapsed(10_800_000)).toEqual({ value: "3h", suffix: "ago" });
    const time = translate("zh", "{time} ago", { time: "3小时" });
    expect(translate("zh", "Checked {time}", { time })).toBe("检查于3小时前");
  });

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
