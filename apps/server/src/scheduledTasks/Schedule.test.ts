import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("returns runAt for a future once schedule and null at or before it", () => {
    const runAt = DateTime.makeUnsafe("2026-07-01T11:00:00+02:00");
    const schedule = { type: "once", runAt: "2026-07-01T11:00:00+02:00" } as const;
    expect(nextScheduledRunAt(schedule, DateTime.makeUnsafe("2026-07-01T08:59:59.999Z"))).toEqual(
      runAt,
    );
    expect(nextScheduledRunAt(schedule, runAt)).toBeNull();
    expect(nextScheduledRunAt(schedule, DateTime.add(runAt, { minutes: 1 }))).toBeNull();
    expect(nextScheduledRunAt({ type: "once", runAt: "not a date" }, runAt)).toBeNull();
  });

  it("compares once schedules by runAt instant", () => {
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-07-01T11:00:00+02:00" },
        { type: "once", runAt: "2026-07-01T09:00:00.000Z" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-07-01T09:00:00Z" },
        { type: "once", runAt: "2026-07-01T09:00:01Z" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "once", runAt: "2026-07-01T09:00:00Z" },
        {
          type: "interval",
          everyMs: 60_000,
        },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        {
          type: "once",
          runAt: "2026-07-01T09:00:00Z",
        },
      ),
    ).toBe(false);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});
