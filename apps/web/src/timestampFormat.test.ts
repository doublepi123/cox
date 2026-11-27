import { describe, expect, it, vi } from "vite-plus/test";

import {
  formatChatTimestampTooltip,
  formatDayAwareTimestamp,
  formatRelativeElapsed,
  formatRelativeTimeLabel,
  formatShortTimestamp,
} from "./timestampFormat";
import { translate } from "./i18n/language";

it("formats the time and date in the current system time zone", () => {
  const previousZone = process.env.TZ;
  const date = "2026-10-31T20:00:00Z";
  try {
    process.env.TZ = "America/New_York";
    expect(formatChatTimestampTooltip(date, "24-hour")).toBe("16:00, 31st October 2026");
    process.env.TZ = "Asia/Bangkok";
    expect(formatChatTimestampTooltip(date, "24-hour")).toBe("03:00, 1st November 2026");
  } finally {
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

it("localizes the day period while honoring the system clock and explicit 24-hour mode", () => {
  const date = new Date(2026, 10, 19, 18, 5);
  const hourCycle = Intl.DateTimeFormat(undefined, { hour: "numeric" }).resolvedOptions()
    .hourCycle!;
  expect(formatShortTimestamp(date.toISOString(), "locale", "zh")).toBe(
    new Intl.DateTimeFormat("zh", { hour: "numeric", minute: "2-digit", hourCycle }).format(date),
  );
  expect(formatShortTimestamp(date.toISOString(), "12-hour", "zh")).toBe("下午6:05");
  expect(formatShortTimestamp(date.toISOString(), "24-hour", "zh")).toBe("18:05");
});

it("formats full timestamps in the system locale", async () => {
  const previousZone = process.env.TZ;
  process.env.TZ = "UTC";
  vi.stubGlobal("navigator", { language: "de-DE" });
  vi.resetModules();
  try {
    const { formatFullTimestamp } = await import("./timestampFormat");
    expect(formatFullTimestamp("2026-11-19T18:05:00.000Z", "24-hour")).toBe("19.11.2026, 18:05:00");
  } finally {
    vi.unstubAllGlobals();
    vi.resetModules();
    if (previousZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousZone;
  }
});

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
