import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs } from "./orchestrationTiming.ts";

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each([undefined, -1, NaN, Infinity])(
    "does not infer cache execution time from synthetic timestamps (%s)",
    (durationMs) => {
      expect(
        deriveSubagentElapsedMs(
          { status: "completed", cached: true, durationMs, startedAt, completedAt: startedAt },
          now,
        ),
      ).toBeNull();
    },
  );
  it.each([0, 1983254])("uses the original cached duration %s without timestamps", (durationMs) => {
    expect(
      deriveSubagentElapsedMs(
        { status: "completed", cached: true, durationMs, startedAt: null, completedAt: null },
        now,
      ),
    ).toBe(durationMs);
  });
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});
