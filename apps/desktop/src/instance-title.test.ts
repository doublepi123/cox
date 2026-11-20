import { describe, expect, it } from "vite-plus/test";
import {
  accentBitmap,
  instanceAccent,
  instanceIdFromArgv,
  instanceLabel,
  instanceRoleTitle,
  instanceWindowTitle,
  windowsInstanceAppId,
  windowsRelaunchCommand,
} from "./instance-title.ts";

describe("instance window titles", () => {
  it("names a local instance and a remote profile, falling back to the hostname", () => {
    expect(instanceLabel({ kind: "local", localLabel: "本地" })).toBe("本地");
    expect(
      instanceLabel({
        kind: "remote",
        localLabel: "本地",
        name: "Office",
        origin: "https://cox.example.com",
      }),
    ).toBe("Office");
    expect(
      instanceLabel({
        kind: "remote",
        localLabel: "本地",
        name: "https://cox.example.com",
        origin: "https://cox.example.com",
      }),
    ).toBe("cox.example.com");
    expect(
      instanceLabel({
        kind: "remote",
        localLabel: "Local",
        origin: "https://build.example.com/cox",
      }),
    ).toBe("build.example.com");
  });

  it("keeps the instance name ahead of Cox and ignores a generic document title", () => {
    expect(instanceWindowTitle("Office")).toBe("Office — Cox");
    expect(instanceWindowTitle("本地", "Cox")).toBe("本地 — Cox");
    expect(instanceWindowTitle("Office", "Cox (Nightly)")).toBe("Office — Cox");
    expect(instanceWindowTitle("Office", "Billing · Cox")).toBe("Office — Billing");
    expect(instanceWindowTitle("Office", "Website redesign")).toBe("Office — Website redesign");
    expect(instanceRoleTitle("Office", "Settings")).toBe("Office — Settings");
  });
});

describe("Windows instance taskbar identity", () => {
  it("gives each instance its own app id, relaunch command, and stable accent", () => {
    expect(windowsInstanceAppId("local")).toBe("dev.cox.desktop.instance.local");
    expect(windowsInstanceAppId("7c9f22fc-6c0e-4d5b-9a6e-0b91e6aa1a20")).toBe(
      "dev.cox.desktop.instance.7c9f22fc-6c0e-4d5b-9a6e-0b91e6aa1a20",
    );
    expect(() => windowsInstanceAppId("a b")).toThrow("Invalid instance id.");
    expect(
      windowsRelaunchCommand({
        execPath: "C:\\Program Files\\Cox\\Cox.exe",
        instanceId: "local",
      }),
    ).toBe('"C:\\Program Files\\Cox\\Cox.exe" --cox-instance=local');
    expect(
      windowsRelaunchCommand({
        execPath: "/usr/bin/electron",
        appPath: "/work/cox",
        instanceId: "remote-a",
      }),
    ).toBe('"/usr/bin/electron" "/work/cox" --cox-instance=remote-a');
    expect(instanceAccent("local")).toBe(instanceAccent("local"));
    expect(instanceAccent("local")).not.toBe(instanceAccent("other-instance"));
    const bitmap = accentBitmap(instanceAccent("local"));
    expect(bitmap).toHaveLength(16 * 16 * 4);
    expect(bitmap[3]).toBe(255);
  });

  it("reads only a safe instance id from a relaunch command", () => {
    expect(instanceIdFromArgv(["Cox.exe", "--cox-instance=local"])).toBe("local");
    expect(instanceIdFromArgv(["Cox.exe", "--cox-instance", "remote_1"])).toBe("remote_1");
    expect(instanceIdFromArgv(["Cox.exe", "--cox-instance=a b"])).toBeUndefined();
    expect(instanceIdFromArgv(["Cox.exe"])).toBeUndefined();
  });
});
