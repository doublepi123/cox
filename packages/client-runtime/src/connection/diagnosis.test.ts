import { expect, it } from "vite-plus/test";
import { AVAILABLE_CONNECTION_STATE, ConnectionTransientError } from "./model.ts";
import { presentConnectionDiagnosis } from "./diagnosis.ts";
it("does not diagnose a connected server", () => {
  expect(
    presentConnectionDiagnosis({
      hostLabel: "Local server",
      state: { ...AVAILABLE_CONNECTION_STATE, phase: "connected" },
    }),
  ).toBeNull();
});
it("gives local recovery advice", () => {
  const diagnosis = presentConnectionDiagnosis({
    hostLabel: "Local server",
    state: {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "backoff",
      lastFailure: new ConnectionTransientError({ reason: "network", detail: "Connection lost" }),
    },
  });
  expect(diagnosis?.headline).toBe("Connection lost");
  expect(diagnosis?.steps.join(" ")).toContain("Cox server");
  expect(diagnosis?.moreInfoUrl).toBeNull();
});
