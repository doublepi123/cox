import { afterEach, expect, it, vi } from "vite-plus/test";
import { currentClientMetadata, subscribeToApplicationWakeups } from "./platform";
afterEach(() => vi.unstubAllGlobals());
it("identifies the local browser without a native bridge", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0", platform: "Linux", maxTouchPoints: 0 });
  expect(currentClientMetadata()).toMatchObject({ surface: "web" });
});

it("checks the connection on focus, page restoration and visibility changes", () => {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledTimes(3);
  unsubscribe();
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledTimes(3);
});

it("does not wake connections for a hidden page", () => {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledOnce();
  unsubscribe();
});
