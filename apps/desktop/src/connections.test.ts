import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
      openInNewWindow: true,
    });
    const stored = readFileSync(join(directory, "connections.json"), "utf8");
    expect(stored).not.toContain("password");
    expect(stored).not.toContain("credential");
  });

  it("defaults new-window connections on without creating a settings file", () => {
    const directory = home();
    expect(new DesktopConnectionStore(directory, null).snapshot()).toEqual({
      active: null,
      profiles: [],
      openInNewWindow: true,
    });
    expect(() => readFileSync(join(directory, "connections.json"))).toThrow();
  });

  it("defaults older settings on without losing profiles or rewriting them", () => {
    const directory = home();
    const profile = new DesktopConnectionStore(directory).saveRemote(inspection, {});
    const stored = JSON.stringify({
      version: 1,
      active: { kind: "remote", profileId: profile.id },
      profiles: [profile],
    });
    writeFileSync(join(directory, "connections.json"), stored);
    expect(new DesktopConnectionStore(directory).snapshot()).toEqual({
      active: { kind: "remote", profileId: profile.id },
      profiles: [profile],
      openInNewWindow: true,
    });
    expect(readFileSync(join(directory, "connections.json"), "utf8")).toBe(stored);
  });

  it.each([false, true])("remembers the last choice %s across restarts", (choice) => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    store.setOpenInNewWindow(!choice);
    store.setOpenInNewWindow(choice);
    expect(store.snapshot().openInNewWindow).toBe(choice);
    expect(new DesktopConnectionStore(directory).snapshot()).toEqual({
      active: null,
      profiles: [],
      openInNewWindow: choice,
    });
    expect(JSON.parse(readFileSync(join(directory, "connections.json"), "utf8"))).toMatchObject({
      openInNewWindow: choice,
    });
  });

  it("keeps the saved choice when profiles and the primary connection change", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    store.setOpenInNewWindow(false);
    const profile = store.saveRemote(inspection, {});
    store.setActive({ kind: "remote", profileId: profile.id });
    store.remove(profile.id);
    store.setActive({ kind: "local" });
    expect(new DesktopConnectionStore(directory).snapshot()).toEqual({
      active: { kind: "local" },
      profiles: [],
      openInNewWindow: false,
    });
  });

  it("does not claim a failed save succeeded and allows the same choice to be retried", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const file = join(directory, "connections.json");
    mkdirSync(file);
    expect(() => store.setOpenInNewWindow(false)).toThrow();
    expect(store.snapshot().openInNewWindow).toBe(true);
    rmSync(file, { recursive: true });
    store.setOpenInNewWindow(false);
    expect(new DesktopConnectionStore(directory).snapshot().openInNewWindow).toBe(false);
  });

  it("rolls back a saved profile when persistence fails", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const file = join(directory, "connections.json");
    mkdirSync(file);
    expect(() => store.saveRemote(inspection, {})).toThrow();
    expect(store.snapshot()).toEqual({ active: null, profiles: [], openInNewWindow: true });
    rmSync(file, { recursive: true });
    store.saveRemote(inspection, {});
    expect(store.snapshot().profiles).toHaveLength(1);
  });

  it("rolls back the active target when persistence fails", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const profile = store.saveRemote(inspection, {});
    const file = join(directory, "connections.json");
    rmSync(file, { force: true });
    mkdirSync(file);
    expect(() => store.setActive({ kind: "remote", profileId: profile.id })).toThrow();
    expect(store.snapshot().active).toBeNull();
    rmSync(file, { recursive: true });
    store.setActive({ kind: "remote", profileId: profile.id });
    expect(store.snapshot().active).toEqual({ kind: "remote", profileId: profile.id });
  });

  it("rolls back a removed profile when persistence fails", () => {
    const directory = home();
    const store = new DesktopConnectionStore(directory, null);
    const profile = store.saveRemote(inspection, {});
    store.setActive({ kind: "remote", profileId: profile.id });
    const file = join(directory, "connections.json");
    rmSync(file, { force: true });
    mkdirSync(file);
    expect(() => store.remove(profile.id)).toThrow();
    expect(store.snapshot()).toEqual({
      active: { kind: "remote", profileId: profile.id },
      profiles: [profile],
      openInNewWindow: true,
    });
    rmSync(file, { recursive: true });
    store.remove(profile.id);
    expect(store.snapshot()).toEqual({ active: null, profiles: [], openInNewWindow: true });
  });

  it.each([null, "false", 0, {}])("rejects a malformed saved new-window choice %j", (choice) => {
    const directory = home();
    writeFileSync(
      join(directory, "connections.json"),
      JSON.stringify({ version: 1, active: null, profiles: [], openInNewWindow: choice }),
    );
    expect(() => new DesktopConnectionStore(directory)).toThrow("Invalid connection settings.");
  });

  it("rejects insecure remote origins before persisting a profile", () => {
    const store = new DesktopConnectionStore(home(), null);
    expect(() =>
      store.saveRemote({ ...inspection, origin: "http://192.168.1.20:3773" }, {}),
    ).toThrow("HTTPS");
    expect(store.snapshot().profiles).toEqual([]);
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
    expect(store.snapshot()).toEqual({ active: null, profiles: [second], openInNewWindow: true });
  });
});
