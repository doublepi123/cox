import { describe, expect, it, vi } from "vite-plus/test";
import { closeDesktopUpdates } from "./update-cleanup.ts";

describe("desktop shutdown update cleanup", () => {
  it("reports failed cache cleanup and still allows the backend to stop", async () => {
    const error = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    const failed = {
      close: vi.fn(async () => {
        throw error;
      }),
    };
    const other = { close: vi.fn(async () => {}) };
    const report = vi.fn();
    const stop = vi.fn(async () => {});
    await closeDesktopUpdates([failed, undefined, other], report);
    await stop();
    expect(failed.close).toHaveBeenCalledOnce();
    expect(other.close).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("waits for every cleanup and records independent errors", async () => {
    const first = new Error("first");
    const second = new Error("second");
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const report = vi.fn();
    let closed = false;
    const closing = closeDesktopUpdates(
      [
        {
          close: async () => {
            throw first;
          },
        },
        {
          close: async () => {
            await pending;
            throw second;
          },
        },
      ],
      report,
    ).then(() => {
      closed = true;
    });
    await vi.waitFor(() => expect(report).toHaveBeenCalledWith(first));
    expect(closed).toBe(false);
    finish();
    await closing;
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(second);
    expect(closed).toBe(true);
  });
});
