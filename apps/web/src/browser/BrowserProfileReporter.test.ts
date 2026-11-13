import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  type ProfileReport,
  type ReportedProfiles,
  takeDueProfileReports,
} from "./BrowserProfileReporter";

const first = EnvironmentId.make("environment-1");
const second = EnvironmentId.make("environment-2");
const config = (label: string) => ({ label }) as unknown as EnvironmentServerConfig;
const input = (recordingFrameRate: number) =>
  ({ profiles: [], defaultProfileId: "default", recordingFrameRate }) as unknown as ProfileReport;

describe("takeDueProfileReports", () => {
  it("reports each environment once per config and input", () => {
    const reported: ReportedProfiles = new Map();
    const configA = config("a");
    const configB = config("b");
    const settings = input(10);
    const targets = new Map([
      [first, configA],
      [second, configB],
    ]);

    expect(takeDueProfileReports(reported, targets, settings)).toEqual([first, second]);
    expect(takeDueProfileReports(reported, new Map(targets), settings)).toEqual([]);

    const restarted = config("a-restarted");
    expect(
      takeDueProfileReports(
        reported,
        new Map([
          [first, restarted],
          [second, configB],
        ]),
        settings,
      ),
    ).toEqual([first]);
  });

  it("reports every target again when the profile settings change", () => {
    const reported: ReportedProfiles = new Map();
    const targets = new Map([
      [first, config("a")],
      [second, config("b")],
    ]);
    takeDueProfileReports(reported, targets, input(10));

    expect(takeDueProfileReports(reported, targets, input(30))).toEqual([first, second]);
  });

  it("reports an environment again once it becomes operable again", () => {
    const reported: ReportedProfiles = new Map();
    const configA = config("a");
    const settings = input(10);
    takeDueProfileReports(reported, new Map([[first, configA]]), settings);

    expect(takeDueProfileReports(reported, new Map(), settings)).toEqual([]);
    expect(takeDueProfileReports(reported, new Map([[first, configA]]), settings)).toEqual([first]);
  });
});

const state = vi.hoisted(() => ({
  hydrated: true,
  settings: {
    browserProfiles: [] as ReadonlyArray<{ id: string; name: string; kind: string }>,
    browserDefaultProfileId: "default",
    browserRecordingFrameRate: 10,
  },
  targets: new Map<unknown, unknown>(),
  listeners: [] as Array<() => void>,
  dispatch: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand: state.dispatch }));
vi.mock("~/hooks/useSettings", () => ({
  getClientSettings: () => state.settings,
  getClientSettingsHydratedSnapshot: () => state.hydrated,
  subscribeClientSettings: (listener: () => void) => {
    state.listeners.push(listener);
    return state.unsubscribe;
  },
  subscribeClientSettingsHydration: (listener: () => void) => {
    state.listeners.push(listener);
    return state.unsubscribe;
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: () => state.targets,
    subscribe: () => state.unsubscribe,
  },
}));
vi.mock("~/state/presentation", () => ({ environmentPresentations: { serverConfigsAtom: {} } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { reportProfiles: {} } }));
vi.mock("~/state/session", () => ({
  environmentSession: { sessionStateAtom: () => undefined },
  sessionHasScope: () => true,
}));

const { startBrowserProfileReporting } = await import("./BrowserProfileReporter");

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

const settleFailure = () => AsyncResult.failure(Cause.fail(new Error("offline")));
const settleSuccess = () => AsyncResult.success(undefined);

describe("startBrowserProfileReporting", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.hydrated = true;
    state.settings = {
      browserProfiles: [],
      browserDefaultProfileId: "default",
      browserRecordingFrameRate: 10,
    };
    state.targets = new Map([[first, config("a")]]);
    state.listeners = [];
    state.dispatch.mockReset();
    state.unsubscribe.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a failed report with the same input and stops after success", async () => {
    const firstAttempt = deferred<unknown>();
    const retryAttempt = deferred<unknown>();
    state.dispatch
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(retryAttempt.promise);

    const stop = startBrowserProfileReporting();
    expect(state.dispatch).toHaveBeenCalledTimes(1);

    for (const listener of state.listeners) listener();
    expect(state.dispatch).toHaveBeenCalledTimes(1);

    firstAttempt.resolve(settleFailure());
    await vi.advanceTimersByTimeAsync(0);
    expect(state.dispatch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.dispatch).toHaveBeenCalledTimes(2);
    expect(state.dispatch.mock.calls[1]?.[2]).toEqual({
      environmentId: first,
      input: { profiles: [], defaultProfileId: "default", recordingFrameRate: 10 },
    });

    retryAttempt.resolve(settleSuccess());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    for (const listener of state.listeners) listener();
    expect(state.dispatch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("keeps a newer successful report when an older attempt settles", async () => {
    const firstAttempt = deferred<unknown>();
    const secondAttempt = deferred<unknown>();
    state.dispatch
      .mockReturnValueOnce(firstAttempt.promise)
      .mockReturnValueOnce(secondAttempt.promise);

    const stop = startBrowserProfileReporting();
    state.settings.browserRecordingFrameRate = 30;
    for (const listener of state.listeners) listener();
    expect(state.dispatch).toHaveBeenCalledTimes(2);

    secondAttempt.resolve(settleSuccess());
    await vi.advanceTimersByTimeAsync(0);
    firstAttempt.resolve(settleFailure());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);

    for (const listener of state.listeners) listener();
    expect(state.dispatch).toHaveBeenCalledTimes(2);
    stop();
  });

  it("cancels pending retries when reporting stops", async () => {
    const attempt = deferred<unknown>();
    state.dispatch.mockReturnValueOnce(attempt.promise);

    const stop = startBrowserProfileReporting();
    attempt.resolve(settleFailure());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
  });

  it("stops retrying after a bounded number of attempts", async () => {
    state.dispatch.mockImplementation(() => Promise.resolve(settleFailure()));

    const stop = startBrowserProfileReporting();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(state.dispatch).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
});
