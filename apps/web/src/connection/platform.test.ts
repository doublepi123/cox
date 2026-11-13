import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";
import {
  currentClientMetadata,
  layerPlatformConnectionSource,
  subscribeToApplicationWakeups,
} from "./platform";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("identifies the local browser without a native bridge", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0", platform: "Linux", maxTouchPoints: 0 });
  expect(currentClientMetadata()).toMatchObject({ surface: "web" });
});

it("coalesces focus, page restoration and visibility events for one foreground return", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledOnce();
  expect(wakeup).toHaveBeenCalledWith("application-active");
  vi.advanceTimersByTime(501);
  browser.dispatchEvent(new Event("focus"));
  expect(wakeup).toHaveBeenCalledTimes(2);
  unsubscribe();
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledTimes(2);
});

it("uses the fast long-resume probe after a long background suspension", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("pagehide"));
  vi.advanceTimersByTime(30_000);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("pageshow"));
  expect(wakeup.mock.calls).toEqual([["application-active-long"]]);
  unsubscribe();
});

it("does not treat a short background return as a long suspension", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  vi.advanceTimersByTime(1000);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup).toHaveBeenCalledWith("application-active");
  unsubscribe();
});

it.each(["pageshow", "resume"])("uses a fast probe on browser %s restoration", (type) => {
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  const event = Object.assign(new Event(type), { persisted: true });
  (type === "resume" ? document : browser).dispatchEvent(event);
  expect(wakeup).toHaveBeenCalledWith("application-active-long");
  unsubscribe();
});

it("coalesces repeated full-resume events without delaying the first fast probe", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  document.dispatchEvent(new Event("resume"));
  browser.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
  browser.dispatchEvent(new Event("focus"));
  expect(wakeup.mock.calls).toEqual([["application-active-long"]]);
  unsubscribe();
});

it("checks a visible page on Wi-Fi or cellular changes and unsubscribes all listeners", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const connection = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { onLine: true, connection });
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  connection.dispatchEvent(new Event("change"));
  browser.dispatchEvent(new Event("online"));
  expect(wakeup.mock.calls).toEqual([["network-changed"]]);
  vi.advanceTimersByTime(501);
  browser.dispatchEvent(new Event("online"));
  expect(wakeup).toHaveBeenCalledTimes(2);
  document.visibilityState = "hidden";
  vi.advanceTimersByTime(501);
  connection.dispatchEvent(new Event("change"));
  expect(wakeup).toHaveBeenCalledTimes(2);
  unsubscribe();
  document.visibilityState = "visible";
  vi.advanceTimersByTime(501);
  connection.dispatchEvent(new Event("change"));
  browser.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("resume"));
  expect(wakeup).toHaveBeenCalledTimes(2);
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

it("defers a background network-change probe until the app becomes visible", () => {
  const browser = new EventTarget();
  const connection = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { connection });
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  connection.dispatchEvent(new Event("change"));
  browser.dispatchEvent(new Event("online"));
  expect(wakeup).not.toHaveBeenCalled();
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup.mock.calls).toEqual([["network-changed"]]);
  unsubscribe();
});

it("does not drop a new network change during a rapid background-and-return", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const browser = new EventTarget();
  const connection = new EventTarget();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("window", browser);
  vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { connection });
  const wakeup = vi.fn();
  const unsubscribe = subscribeToApplicationWakeups(wakeup);
  browser.dispatchEvent(new Event("focus"));
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  connection.dispatchEvent(new Event("change"));
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(wakeup.mock.calls).toEqual([["application-active"], ["network-changed"]]);
  unsubscribe();
});

describe("primary connection discovery", () => {
  it.effect("retains the initial failure and recovers when retry is requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        vi.stubGlobal("window", { location: { origin: "http://127.0.0.1:4773" } });
        const fetchDescriptor = vi
          .fn()
          .mockResolvedValueOnce(new Response("Unavailable", { status: 500 }))
          .mockResolvedValue(
            Response.json({
              environmentId: "local",
              label: "Local server",
              platform: { os: "linux", arch: "x64" },
              serverVersion: "0.1.0",
              orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
              capabilities: { repositoryIdentity: true },
            }),
          );
        vi.stubGlobal("fetch", fetchDescriptor);
        const context = yield* Layer.build(layerPlatformConnectionSource);
        const source = Context.get(context, PlatformConnectionSource.PlatformConnectionSource);

        const initial = Option.getOrNull(yield* Stream.runHead(source.registrations));
        expect(initial).toMatchObject({
          registrations: [],
          error: { _tag: "ConnectionTransientError" },
        });

        yield* source.retry;
        const recovered = Option.getOrNull(yield* Stream.runHead(source.registrations));
        expect(recovered).toMatchObject({
          registrations: [{ target: { environmentId: "local", label: "Local server" } }],
          error: null,
        });
      }),
    ),
  );
});
