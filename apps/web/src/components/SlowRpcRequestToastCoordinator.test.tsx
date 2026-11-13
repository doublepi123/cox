import { describe, expect, it, vi } from "vite-plus/test";

import { setLanguagePreference } from "../i18n";
import { acknowledgeRpcRequest, trackRpcRequestSent } from "../rpc/requestLatencyState";
import { startSlowRpcRequestToasts } from "./SlowRpcRequestToastCoordinator";
import { toastManager } from "./ui/toast";

describe("slow request toast", () => {
  it.each([
    ["en", ["slow-1"], "Some requests are slow", "1 request waiting longer than 15s."],
    ["en", ["slow-1", "slow-2"], "Some requests are slow", "2 requests waiting longer than 15s."],
    ["zh", ["slow-1"], "部分请求响应缓慢", "1 个请求等待超过 15 秒。"],
    ["zh", ["slow-1", "slow-2"], "部分请求响应缓慢", "2 个请求等待超过 15 秒。"],
  ] as const)("summarizes in %s for %j", (language, requestIds, title, description) => {
    vi.useFakeTimers();
    setLanguagePreference(language);
    using add = vi.spyOn(toastManager, "add").mockReturnValue("slow-requests");
    using update = vi.spyOn(toastManager, "update").mockImplementation(() => {});
    using _close = vi.spyOn(toastManager, "close").mockImplementation(() => {});
    using _cleanup = {
      [Symbol.dispose]: () => {
        for (const requestId of requestIds) acknowledgeRpcRequest(requestId);
        setLanguagePreference("system");
        vi.useRealTimers();
      },
    };
    using _toasts = { [Symbol.dispose]: startSlowRpcRequestToasts() };
    for (const requestId of requestIds) trackRpcRequestSent(requestId, "orchestration.dispatch");
    vi.advanceTimersByTime(15_000);
    const updated = update.mock.calls.at(-1)?.[1];
    const toast =
      typeof updated === "function" ? undefined : (updated ?? add.mock.calls.at(-1)?.[0]);
    expect(toast?.title).toBe(title);
    expect(toast?.description).toBe(description);
    expect(toast?.data?.expandableLabels).toEqual(
      language === "zh"
        ? { collapse: "隐藏请求", expand: "显示请求" }
        : { collapse: "Hide requests", expand: "Show requests" },
    );
  });
});
