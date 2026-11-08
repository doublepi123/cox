import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { armFreshSession, disarmFreshSession, readFreshSessionArm } from "./freshSessionArms.ts";

afterEach(() => vi.useRealTimers());

describe("fresh session arms", () => {
  it("does not consume a newer arm created in the same clock tick", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    const key = "fresh-arm:same-tick";
    armFreshSession(key);
    const first = readFreshSessionArm(key)!;
    armFreshSession(key);
    const second = readFreshSessionArm(key)!;
    expect(second).toBeGreaterThan(first);
    disarmFreshSession(key, first);
    expect(readFreshSessionArm(key)).toBe(second);
    disarmFreshSession(key, second);
    expect(readFreshSessionArm(key)).toBeUndefined();
  });

  it("keeps arms scoped to their thread and allows explicit cancellation", () => {
    armFreshSession("fresh-arm:a");
    armFreshSession("fresh-arm:b");
    const other = readFreshSessionArm("fresh-arm:b");
    disarmFreshSession("fresh-arm:a");
    expect(readFreshSessionArm("fresh-arm:a")).toBeUndefined();
    expect(readFreshSessionArm("fresh-arm:b")).toBe(other);
    disarmFreshSession("fresh-arm:missing");
    disarmFreshSession("fresh-arm:b");
  });
});
