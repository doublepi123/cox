import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { desktopSoftwareUpdatePlan } from "./desktopUpdates.ts";

const backend: DesktopBackendUpdateState = {
  desktopVersion: "0.2.16",
  bundledVersion: null,
  currentVersion: "0.1.54",
  latestVersion: "0.1.55",
  status: "ready",
  message: null,
};
const client: DesktopClientUpdateState = {
  currentVersion: "0.2.16",
  latestVersion: "0.2.17",
  status: "ready",
  message: null,
  progress: null,
  installMode: "automatic",
  automaticChecks: true,
  ignoredVersion: null,
};

describe("software update presentation", () => {
  it.each(["available", "checking", "installing", "error"] as const)(
    "does not present a ready client before a backend in %s is resolved",
    (status) => {
      const plan = desktopSoftwareUpdatePlan({ ...backend, status }, client);
      expect(plan.status).not.toBe("ready");
    },
  );

  it("does not hide a failed client behind a ready backend", () => {
    expect(desktopSoftwareUpdatePlan(backend, { ...client, status: "error" }).status).toBe("error");
  });

  it("never claims both products are current before both were checked", () => {
    expect(
      desktopSoftwareUpdatePlan(
        { ...backend, status: "idle", latestVersion: backend.currentVersion },
        { ...client, status: "idle", latestVersion: null },
      ).status,
    ).toBe("idle");
  });

  it("allows a ready client to deliver an updated runtime", () => {
    expect(desktopSoftwareUpdatePlan({ ...backend, status: "incompatible" }, client).status).toBe(
      "ready",
    );
    expect(
      desktopSoftwareUpdatePlan(
        { ...backend, status: "incompatible" },
        { ...client, status: "idle" },
      ).status,
    ).toBe("incompatible");
  });
});
