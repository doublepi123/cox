import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { DesktopConnectionStore } from "./connections.ts";

const homes: string[] = [];
function home(): string {
  const directory = mkdtempSync(join(tmpdir(), "cox-desktop-connections-"));
  homes.push(directory);
  return directory;
}

const inspection = {
  origin: "https://cox.example.com",
  environmentId: "environment-1",
  label: "Build server",
  serverVersion: "0.1.56",
};

afterEach(() => {
  for (const directory of homes.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("desktop connection persistence", () => {
  it("persists non-secret profiles and the selected target", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const profile = store.saveRemote(inspection, { name: "Office" });
    store.setActive({ kind: "remote", profileId: profile.id });
    const restored = new DesktopConnectionStore(directory);
    expect(restored.snapshot()).toEqual({
      active: { kind: "remote", profileId: profile.id },
      profiles: [profile],
    });
    const stored = readFileSync(join(directory, "connections.json"), "utf8");
    expect(stored).not.toContain("password");
    expect(stored).not.toContain("credential");
  });

  it("persists a password-protected HTTP origin without storing credentials", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const profile = store.saveRemote(
      { ...inspection, origin: "http://192.168.1.20:3773" },
      { name: "Trusted LAN" },
    );
    store.setActive({ kind: "remote", profileId: profile.id });
    expect(new DesktopConnectionStore(directory).profile(profile.id)?.origin).toBe(
      "http://192.168.1.20:3773",
    );
  });

  it("reuses an origin and pins its environment identity", () => {
    const store = new DesktopConnectionStore(home());
    const first = store.saveRemote(inspection, {});
    const second = store.saveRemote({ ...inspection, serverVersion: "0.1.57" }, {});
    expect(second.id).toBe(first.id);
    expect(store.snapshot().profiles).toHaveLength(1);
    expect(() =>
      store.saveRemote({ ...inspection, environmentId: "replacement" }, { id: first.id }),
    ).toThrow("server identity changed");
  });

  it("forgets only the selected profile and clears its active selection", () => {
    const store = new DesktopConnectionStore(home());
    const first = store.saveRemote(inspection, {});
    const second = store.saveRemote(
      { ...inspection, origin: "https://other.example.com", environmentId: "environment-2" },
      {},
    );
    store.setActive({ kind: "remote", profileId: first.id });
    store.remove(first.id);
    expect(store.snapshot()).toEqual({ active: null, profiles: [second] });
  });
});
