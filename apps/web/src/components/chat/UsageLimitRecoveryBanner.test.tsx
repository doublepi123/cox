import { RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  CHATGPT_USAGE_LIMIT_CODE,
  CHATGPT_WORKSPACE_USAGE_LIMIT_CODE,
} from "@t3tools/shared/usageLimits";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerDescription(resetAt: Date, timestampFormat: TimestampFormat) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    errorCode: null,
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    onChange: async () => {},
  }).description;
}

describe("usageLimitRecoveryBannerItem", () => {
  function renderBanner(errorCode: string | null, resetAt: string | null = null) {
    const item = usageLimitRecoveryBannerItem({
      runId: RunId.make("run-limit"),
      errorCode,
      resetAt,
      stoppedAt: stoppedAt.toISOString(),
      snoozedUntil: null,
      recovery: null,
      timestampFormat: "24-hour",
      onChange: async () => {},
    });
    return renderToStaticMarkup(
      <div>
        {item.title}
        {item.description}
        {item.actions}
      </div>,
    );
  }

  it("offers ChatGPT usage management without inventing a reset time", () => {
    const markup = renderBanner(CHATGPT_USAGE_LIMIT_CODE);
    expect(markup).toContain("ChatGPT usage limit reached");
    expect(markup).toContain("Manage usage");
    expect(markup).toContain("Reset time unavailable; retry manually");
    expect(markup).not.toContain("Resume at reset");
    expect(markup).not.toContain("Snooze until reset");
    expect(markup).not.toContain("Copy request for admin");
  });

  it("offers an admin request for workspace sharing limits", () => {
    const markup = renderBanner(CHATGPT_WORKSPACE_USAGE_LIMIT_CODE);
    expect(markup).toContain("ChatGPT usage limit reached");
    expect(markup).toContain("workspace&#x27;s limit");
    expect(markup).toContain("Copy request for admin");
    expect(markup).not.toContain("Manage usage");
    expect(markup).not.toContain("Resume at reset");
  });

  it("keeps manual recovery for an ordinary allowance with no reset time", () => {
    const markup = renderBanner(null);
    expect(markup).toContain("Usage limit reached");
    expect(markup).toContain("Reset time unavailable; retry manually");
    expect(markup).not.toContain("Manage usage");
    expect(markup).not.toContain("Copy request for admin");
    expect(markup).not.toContain("Resume at reset");
  });

  it("keeps scheduled recovery for ordinary limits with a known future reset", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    const markup = renderBanner(null, new Date(2026, 9, 20, 17, 30).toISOString());
    expect(markup).toContain("Resets 17:30");
    expect(markup).toContain("Resume at reset");
    expect(markup).toContain("Snooze until reset");
  });

  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 20, 17, 30), timestampFormat)).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerDescription(new Date(2026, 9, 21, 17, 30), "24-hour")).toBe(
      "Resets tomorrow at 17:30",
    );
  });
});
