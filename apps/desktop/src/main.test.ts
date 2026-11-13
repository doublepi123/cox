import { EventEmitter } from "node:events";
import { renameSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { BrowserWindowConstructorOptions, MenuItemConstructorOptions } from "electron";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { RemoteConnectionProfile } from "./connections.ts";

const userHome = resolve("/fixture/user");
const resourcesPath = resolve("/fixture/resources");
const home = join(userHome, ".cox", "desktop");
const connectionsFile = join(home, "connections.json");
const backendMetadataFile = join(resourcesPath, "backend.json");
const localOrigin = "http://127.0.0.1:3773";
const inspection = {
  origin: "https://cox.example.com",
  environmentId: "environment-1",
  label: "Build server",
  serverVersion: "0.1.60",
};
const saved: RemoteConnectionProfile = {
  ...inspection,
  id: "7c9f22fc-6c0e-4d5b-9a6e-0b91e6aa1a20",
  name: "Office",
};

class TestContents extends EventEmitter {
  readonly id = fixture.windows.length + 1;
  readonly mainFrame = { url: "" };
  readonly send = vi.fn();
  readonly setWindowOpenHandler = vi.fn();
  readonly session: ReturnType<typeof createSession>;
  constructor(session: ReturnType<typeof createSession>) {
    super();
    this.session = session;
  }
  getURL() {
    return this.mainFrame.url;
  }
  isCrashed() {
    return false;
  }
  getZoomFactor() {
    return 1;
  }
}

function createSession() {
  return {
    setPermissionCheckHandler: vi.fn(),
    setPermissionRequestHandler: vi.fn(),
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {}),
    clearAuthCache: vi.fn(async () => {}),
  };
}

function fromPartition(partition: string) {
  let value = fixture.sessions.get(partition);
  if (!value) {
    value = createSession();
    fixture.sessions.set(partition, value);
  }
  return value;
}

class TestWindow extends EventEmitter {
  static getFocusedWindow() {
    return fixture.focused;
  }
  static fromWebContents(contents: TestContents) {
    return fixture.windows.find((target) => target.webContents === contents);
  }
  readonly webContents: TestContents;
  readonly setMenuBarVisibility = vi.fn();
  readonly setTitle = vi.fn();
  readonly setWindowButtonPosition = vi.fn();
  readonly setPosition = vi.fn();
  readonly options: BrowserWindowConstructorOptions;
  visible: boolean;
  destroyed = false;
  constructor(options: BrowserWindowConstructorOptions) {
    super();
    this.options = options;
    this.visible = options.show !== false;
    this.webContents = new TestContents(fromPartition(options.webPreferences?.partition ?? ""));
    fixture.windows.push(this);
  }
  async loadURL(url: string) {
    await fixture.loadURL(url);
    this.webContents.mainFrame.url = url;
    this.webContents.emit("did-finish-load");
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return false;
  }
  isMaximized() {
    return false;
  }
  getBounds() {
    return { x: 0, y: 0, width: this.options.width, height: this.options.height };
  }
  isFullScreen() {
    return false;
  }
  restore() {
    this.visible = true;
  }
  show() {
    this.visible = true;
  }
  hide() {
    this.visible = false;
  }
  focus() {
    fixture.focused = this;
  }
  getSize() {
    return [this.options.width, this.options.height];
  }
  close() {
    const event = { preventDefault: vi.fn() };
    this.emit("close", event);
    if (!event.preventDefault.mock.calls.length) this.destroy();
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    if (fixture.focused === this) fixture.focused = undefined;
    this.emit("closed");
  }
}

const fixture = {
  windows: [] as TestWindow[],
  focused: undefined as TestWindow | undefined,
  files: new Map<string, string>(),
  sessions: new Map<string, ReturnType<typeof createSession>>(),
  handlers: new Map<string, (event: unknown, input?: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, input?: unknown) => void>(),
  events: new EventEmitter(),
  started: Promise.resolve() as Promise<unknown>,
  loadURL: vi.fn(async (_url: string) => {}),
  launchBackend: vi.fn(async (_start: (directory: string) => Promise<string>) => localOrigin),
  backendExit: undefined as ((message: string) => void) | undefined,
  inspect: vi.fn(async (_origin: string) => inspection),
  clientCheck: vi.fn(async () => undefined),
  clientState: {} as { status?: string; currentVersion?: string; latestVersion?: string },
  clientApply: vi.fn(async () => {}),
  softwareCheck: vi.fn(async () => undefined),
  softwareApply: vi.fn(async () => {}),
  messageBox: vi.fn(async () => ({ response: 1 })),
  quit: vi.fn(),
  errors: vi.fn(),
  menu: [] as MenuItemConstructorOptions[],
};

vi.mock("node:os", () => ({ homedir: () => userHome }));
vi.mock("node:child_process", () => ({ execFileSync: () => "v26.12.1" }));
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  existsSync: (path: string) =>
    path.startsWith(join(resourcesPath, "runtime")) || fixture.files.has(path),
  readFileSync: (path: string) => {
    if (basename(path) === "icon.png") return Buffer.from("icon");
    const contents = fixture.files.get(path);
    if (contents === undefined) throw new Error("Missing fixture file: " + path);
    return contents;
  },
  writeFileSync: (path: string, contents: string) => fixture.files.set(path, contents),
  renameSync: vi.fn((source: string, destination: string) => {
    fixture.files.set(destination, fixture.files.get(source)!);
    fixture.files.delete(source);
  }),
  statSync: () => ({ size: 0 }),
  createWriteStream: () => ({ on: vi.fn(), write: vi.fn() }),
}));
vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    setPath: vi.fn(),
    setAppLogsPath: vi.fn(),
    setName: vi.fn(),
    getVersion: () => "0.2.24",
    getPreferredSystemLanguages: () => ["en-US"],
    requestSingleInstanceLock: () => true,
    commandLine: { getSwitchValue: () => "", hasSwitch: () => true },
    on: fixture.events.on.bind(fixture.events),
    quit: fixture.quit,
    whenReady: () => {
      const ready = Promise.resolve();
      vi.spyOn(ready, "then").mockImplementation((onFulfilled, onRejected) => {
        const result = Promise.resolve().then(onFulfilled, onRejected);
        fixture.started = result;
        return result;
      });
      return ready;
    },
  },
  BrowserWindow: TestWindow,
  ipcMain: {
    on: (name: string, action: (event: unknown, input?: unknown) => void) =>
      fixture.listeners.set(name, action),
    handle: (name: string, action: (event: unknown, input?: unknown) => Promise<unknown>) =>
      fixture.handlers.set(name, action),
  },
  dialog: { showErrorBox: fixture.errors, showMessageBox: fixture.messageBox },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: (menu: MenuItemConstructorOptions[]) => (fixture.menu = menu),
    getApplicationMenu: () => ({ getMenuItemById: () => undefined }),
  },
  net: { fetch: vi.fn() },
  screen: {},
  session: { fromPartition },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
vi.mock("./backend.ts", () => ({
  BackendProcess: class {
    constructor(options: { onUnexpectedExit: (message: string) => void }) {
      fixture.backendExit = options.onUnexpectedExit;
    }
    async start() {
      return localOrigin;
    }
    async stop() {}
  },
  validateBackendInstallation: vi.fn(),
}));
vi.mock("./backend-updates.ts", () => ({
  BackendUpdates: class {
    launch = fixture.launchBackend;
    getState() {
      return {};
    }
  },
}));
vi.mock("./client-updates.ts", () => ({
  ClientUpdates: class {
    check = fixture.clientCheck;
    apply = fixture.clientApply;
    getState() {
      return fixture.clientState;
    }
  },
}));
vi.mock("./software-updates.ts", () => ({
  SoftwareUpdates: class {
    check = fixture.softwareCheck;
    apply = fixture.softwareApply;
  },
  softwareUpdateReady: vi.fn(),
}));
vi.mock("./mac-update.ts", () => ({ MacAppUpdate: vi.fn() }));
vi.mock("./mac-update-transaction.ts", () => ({
  loadMacUpdateLaunch: vi.fn(),
  macUpdateInProgress: async () => false,
}));
vi.mock("./remote.ts", async (original) => ({
  ...(await original<typeof import("./remote.ts")>()),
  inspectRemoteServer: fixture.inspect,
}));

function invoke(channel: string, target: TestWindow, input?: unknown) {
  const handler = fixture.handlers.get(channel);
  if (!handler) throw new Error("Missing IPC handler: " + channel);
  return handler({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, input);
}

function send(channel: string, target: TestWindow, input?: unknown) {
  const listener = fixture.listeners.get(channel);
  if (!listener) throw new Error("Missing IPC listener: " + channel);
  listener({ sender: target.webContents, senderFrame: target.webContents.mainFrame }, input);
}

function pages(kind: "settings" | "usage") {
  return fixture.windows.filter(
    (target) =>
      !target.destroyed &&
      target.options.webPreferences?.additionalArguments?.includes("--cox-window-kind=" + kind),
  );
}

function satellites() {
  return fixture.windows.filter(
    (target) =>
      !target.destroyed &&
      target.options.webPreferences?.additionalArguments?.includes("--cox-satellite=true"),
  );
}

function clickMenu(match: (item: MenuItemConstructorOptions) => boolean) {
  const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
  const item = flatten(fixture.menu).find(match);
  if (!item?.click) throw new Error("Missing menu action");
  Reflect.apply(item.click, undefined, []);
}

function manager() {
  const target = fixture.windows.find(
    (value) =>
      !value.destroyed && value.options.webPreferences?.partition === "cox-connection-manager",
  );
  if (!target) throw new Error("Missing connection manager");
  return target;
}

function primary() {
  const target = fixture.windows.find(
    (value) =>
      !value.destroyed &&
      value.options.webPreferences?.partition !== "cox-connection-manager" &&
      value.options.webPreferences?.additionalArguments?.includes("--cox-window-kind=main") &&
      !value.options.webPreferences?.additionalArguments?.includes("--cox-satellite=true"),
  );
  if (!target) throw new Error("Missing primary window");
  return target;
}

async function start() {
  await import("./main.ts");
  await fixture.started;
  expect(fixture.errors).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("process", Object.assign(Object.create(process), { resourcesPath }));
  fixture.windows.length = 0;
  fixture.focused = undefined;
  fixture.files.clear();
  fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: null }));
  fixture.sessions.clear();
  fixture.handlers.clear();
  fixture.listeners.clear();
  fixture.events.removeAllListeners();
  fixture.launchBackend.mockReset().mockResolvedValue(localOrigin);
  fixture.backendExit = undefined;
  fixture.inspect.mockReset().mockResolvedValue(inspection);
  fixture.loadURL.mockReset().mockResolvedValue(undefined);
  fixture.clientState = {};
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop connection manager windows", () => {
  it("opens and reuses a separate local usage window without navigating the main window", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    const local = primary();
    await invoke("cox:usage-open", local, "/usage?metric=tokens#models");
    const target = pages("usage")[0]!;
    expect(target.webContents.getURL()).toBe(localOrigin + "/usage?metric=tokens#models");
    expect(target.options.webPreferences?.partition).toBe("persist:cox-desktop");
    expect(local.webContents.getURL()).toBe(localOrigin);
    target.close();
    expect(target.destroyed).toBe(false);
    expect(target.visible).toBe(false);
    await invoke("cox:usage-open", local, "/usage");
    expect(pages("usage")).toEqual([target]);
    expect(target.visible).toBe(true);
    expect(fixture.launchBackend).toHaveBeenCalledTimes(1);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("opens settings separately for the remote primary with its own session and restricted IPC", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      }),
    );
    await start();
    const remote = primary();
    await invoke("cox:settings-open", remote, "/settings/providers?instanceId=codex#models");
    const target = pages("settings")[0]!;
    expect(target).not.toBe(remote);
    expect(target.webContents.getURL()).toBe(
      inspection.origin + "/settings/providers?instanceId=codex#models",
    );
    expect(target.webContents.session).toBe(remote.webContents.session);
    expect(target.options.webPreferences?.additionalArguments).toContain("--cox-remote=true");
    expect(remote.webContents.getURL()).toBe(inspection.origin);
    expect(() => invoke("cox:backend-update-state", target)).toThrow("Untrusted");
    expect(() => invoke("cox:client-update-state", target)).toThrow("Untrusted");
    await invoke("cox:settings-open", remote, "/settings/appearance");
    send("cox:desktop-ready", target, { settingsWindow: true, usageWindow: true });
    expect(target.webContents.send).toHaveBeenCalledWith("cox:navigate", "/settings/appearance");
    target.close();
    expect(target.destroyed).toBe(false);
    expect(target.webContents.send).toHaveBeenCalledWith("cox:settings-close-requested");
    send("cox:settings-close", target);
    expect(target.visible).toBe(false);
    await invoke("cox:settings-open", remote, "/settings");
    expect(pages("settings")).toEqual([target]);
    expect(target.visible).toBe(true);
    expect(fixture.launchBackend).not.toHaveBeenCalled();
  });

  it("keeps each remote connection's settings and usage separate and returns links to their owner", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    const local = primary();
    await invoke("cox:connections-show", local);
    const connections = manager();
    for (let index = 0; index < 2; index++) {
      fixture.inspect.mockResolvedValueOnce({
        ...inspection,
        origin: `https://remote-${index}.example.com`,
        environmentId: "environment-" + index,
      });
      await invoke("cox:connections-connect", connections, {
        origin: `https://remote-${index}.example.com`,
        openInNewWindow: true,
      });
    }
    const [first, second] = satellites() as [TestWindow, TestWindow];
    for (const remote of [first, second]) {
      await invoke("cox:settings-open", remote, "/settings/general");
      await invoke("cox:usage-open", remote, "/usage");
    }
    expect(pages("settings")).toHaveLength(2);
    expect(pages("usage")).toHaveLength(2);
    const [firstSettings, secondSettings] = pages("settings") as [TestWindow, TestWindow];
    const [firstUsage, secondUsage] = pages("usage") as [TestWindow, TestWindow];
    expect(firstSettings.webContents.session).toBe(first.webContents.session);
    expect(firstUsage.webContents.session).toBe(first.webContents.session);
    expect(secondSettings.webContents.session).toBe(second.webContents.session);
    expect(firstUsage.webContents.session).not.toBe(secondUsage.webContents.session);
    for (const target of [firstSettings, secondSettings, firstUsage, secondUsage]) {
      expect(() => invoke("cox:backend-update-state", target)).toThrow("Untrusted");
      send("cox:desktop-ready", target, { settingsWindow: true, usageWindow: true });
      expect(target.webContents.send).not.toHaveBeenCalledWith(
        "cox:backend-update",
        expect.anything(),
      );
      expect(target.webContents.send).not.toHaveBeenCalledWith(
        "cox:client-update",
        expect.anything(),
      );
    }
    await invoke("cox:main-open", firstSettings, "/threads/first");
    expect(first.webContents.send).toHaveBeenCalledWith("cox:navigate", "/threads/first");
    expect(second.webContents.send).not.toHaveBeenCalledWith("cox:navigate", "/threads/first");
    expect(local.webContents.send).not.toHaveBeenCalledWith("cox:navigate", "/threads/first");
    await invoke("cox:usage-open", firstSettings, "/usage");
    expect(pages("usage")).toHaveLength(2);
    send("cox:usage-close", firstUsage);
    expect(firstUsage.visible).toBe(false);
    expect(first.visible).toBe(true);
    first.destroy();
    expect(firstSettings.destroyed).toBe(true);
    expect(firstUsage.destroyed).toBe(true);
    expect(secondSettings.destroyed).toBe(false);
    expect(secondUsage.destroyed).toBe(false);
    expect(local.webContents.getURL()).toBe(localOrigin);
    expect(fixture.launchBackend).toHaveBeenCalledTimes(1);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it.each(["cox:settings-open", "cox:usage-open"])(
    "rejects other-frame and untrusted %s requests",
    async (channel) => {
      await start();
      expect(() => invoke(channel, manager(), "/usage")).toThrow("Untrusted");
      expect(() => invoke(channel, primary(), "/usage")).toThrow("Untrusted");
      await invoke("cox:connections-connect", manager(), {
        origin: inspection.origin,
        openInNewWindow: true,
      });
      const remote = satellites()[0]!;
      expect(() =>
        fixture.handlers.get(channel)!(
          { sender: remote.webContents, senderFrame: { url: remote.webContents.getURL() } },
          "/usage",
        ),
      ).toThrow("Untrusted");
      for (const path of [
        "//evil.test/usage",
        "/\\evil.test/settings",
        "https://evil.test/settings",
        "/api/auth/session",
      ])
        await expect(invoke(channel, remote, path)).rejects.toThrow("Invalid");
      expect(pages("usage")).toHaveLength(0);
      expect(pages("settings")).toHaveLength(0);
    },
  );

  it("blocks foreign-origin navigation and cleans up failed auxiliary page loads", async () => {
    await start();
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const remote = satellites()[0]!;
    await invoke("cox:usage-open", remote, "/usage");
    const usage = pages("usage")[0]!;
    for (const url of ["https://evil.test/usage", inspection.origin + "/api/auth/session"]) {
      const event = { preventDefault: vi.fn() };
      usage.webContents.emit("will-navigate", event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    fixture.loadURL.mockRejectedValueOnce(new Error("Auxiliary page failed"));
    await expect(invoke("cox:settings-open", remote, "/settings/general")).rejects.toThrow(
      "Auxiliary page failed",
    );
    expect(pages("settings")).toHaveLength(0);
    expect(remote.destroyed).toBe(false);
  });

  it("uses the focused remote owner for native settings, Connections, Open Cox and update actions", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    const local = primary();
    await invoke("cox:connections-show", local);
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const remote = satellites()[0]!;
    await invoke("cox:usage-open", remote, "/usage");
    const usage = pages("usage")[0]!;
    usage.focus();
    clickMenu((item) => item.accelerator === "CmdOrCtrl+,");
    const settings = pages("settings")[0]!;
    expect(settings.webContents.session).toBe(remote.webContents.session);
    await vi.waitFor(() =>
      expect(settings.webContents.getURL()).toBe(inspection.origin + "/settings/general"),
    );
    settings.focus();
    clickMenu((item) => item.label === "Open Cox");
    expect(fixture.focused).toBe(remote);
    settings.focus();
    clickMenu((item) => item.accelerator === "CmdOrCtrl+Shift+O");
    clickMenu((item) => item.accelerator === "CmdOrCtrl+,");
    expect(pages("settings")).toEqual([settings]);
    settings.focus();
    clickMenu((item) => item.id === "cox-check-updates");
    expect(fixture.clientCheck).toHaveBeenCalledWith(true);
    expect(fixture.softwareCheck).not.toHaveBeenCalled();
    expect(local.webContents.getURL()).toBe(localOrigin);
    expect(fixture.launchBackend).toHaveBeenCalledTimes(1);
  });

  it("keeps distinct owners on the same saved remote profile from reusing each other's pages", async () => {
    await start();
    const connections = manager();
    for (let index = 0; index < 2; index++)
      await invoke("cox:connections-connect", connections, {
        origin: inspection.origin,
        openInNewWindow: true,
      });
    const [first, second] = satellites() as [TestWindow, TestWindow];
    for (const owner of [first, second]) {
      await invoke("cox:settings-open", owner, "/settings/general");
      await invoke("cox:usage-open", owner, "/usage");
    }
    expect(first.webContents.session).toBe(second.webContents.session);
    expect(pages("settings")).toHaveLength(2);
    expect(pages("usage")).toHaveLength(2);
    await invoke("cox:main-open", pages("usage")[1]!, "/threads/second");
    expect(second.webContents.send).toHaveBeenCalledWith("cox:navigate", "/threads/second");
    expect(first.webContents.send).not.toHaveBeenCalledWith("cox:navigate", "/threads/second");
    first.destroy();
    expect(pages("settings")).toHaveLength(1);
    expect(pages("usage")).toHaveLength(1);
  });

  it("keeps native remote update confirmation client-only and warns about a running local backend", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    await invoke("cox:connections-show", primary());
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const remote = satellites()[0]!;
    send("cox:desktop-ready", remote);
    await invoke("cox:usage-open", remote, "/usage");
    pages("usage")[0]!.focus();
    fixture.clientState = { status: "ready", currentVersion: "0.2.25", latestVersion: "0.2.26" };
    fixture.messageBox.mockResolvedValueOnce({ response: 0 });
    clickMenu((item) => item.id === "cox-check-updates");
    await vi.waitFor(() =>
      expect(fixture.messageBox).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Restart and install updates?",
          message: "Updating quits Cox and interrupts running agent tasks and terminals.",
          detail: "Cox Desktop 0.2.25 → 0.2.26",
        }),
      ),
    );
    expect(fixture.softwareApply).not.toHaveBeenCalled();
    expect(fixture.clientApply).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("rejects cross-frame, foreign-origin and wrong-role auxiliary close and navigation IPC", async () => {
    await start();
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const remote = satellites()[0]!;
    await invoke("cox:settings-open", remote, "/settings/general");
    await invoke("cox:usage-open", remote, "/usage");
    const settings = pages("settings")[0]!;
    const usage = pages("usage")[0]!;
    send("cox:settings-close", usage);
    send("cox:usage-close", settings);
    for (const target of [settings, usage]) {
      const childFrame = {
        sender: target.webContents,
        senderFrame: { url: target.webContents.getURL() },
      };
      expect(() => fixture.handlers.get("cox:main-open")!(childFrame, "/threads/other")).toThrow(
        "Invalid",
      );
      fixture.listeners.get("cox:" + (target === settings ? "settings" : "usage") + "-close")!(
        childFrame,
      );
      expect(target.visible).toBe(true);
      target.webContents.mainFrame.url = "https://untrusted.example.com/usage";
      expect(() => invoke("cox:settings-open", target, "/settings/general")).toThrow("Untrusted");
      expect(() => invoke("cox:usage-open", target, "/usage")).toThrow("Untrusted");
      send("cox:" + (target === settings ? "settings" : "usage") + "-close", target);
      expect(target.visible).toBe(true);
    }
    expect(remote.webContents.send).not.toHaveBeenCalledWith("cox:navigate", "/threads/other");
  });

  it("revokes stale page IPC and navigation when the owner's document no longer matches its origin", async () => {
    await start();
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const owner = satellites()[0]!;
    await invoke("cox:usage-open", owner, "/usage");
    const usage = pages("usage")[0]!;
    owner.webContents.mainFrame.url = "https://untrusted.example.com";
    expect(() => invoke("cox:main-open", usage, "/threads/selected")).toThrow("Invalid");
    expect(() => invoke("cox:settings-open", usage, "/settings/general")).toThrow("Untrusted");
    send("cox:usage-close", usage);
    expect(usage.visible).toBe(true);
    const event = { preventDefault: vi.fn() };
    usage.webContents.emit("will-redirect", event, inspection.origin + "/usage");
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("cleans primary-owned pages on same-profile reconnect, connection switch and owner close", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      }),
    );
    await start();
    const remote = primary();
    await invoke("cox:settings-open", remote, "/settings/general");
    await invoke("cox:usage-open", remote, "/usage");
    const previous = [...pages("settings"), ...pages("usage")];
    await invoke("cox:connections-show", remote);
    await invoke("cox:connections-connect", manager(), { id: saved.id, openInNewWindow: false });
    expect(primary()).toBe(remote);
    expect(previous.every((page) => page.destroyed)).toBe(true);
    await invoke("cox:usage-open", remote, "/usage");
    const beforeSwitch = pages("usage")[0]!;
    await invoke("cox:connections-show", remote);
    fixture.inspect.mockResolvedValueOnce({ ...inspection, origin: "https://other.example.com" });
    await invoke("cox:connections-connect", manager(), {
      origin: "https://other.example.com",
      openInNewWindow: false,
    });
    expect(beforeSwitch.destroyed).toBe(true);
    expect(remote.destroyed).toBe(true);
    const next = primary();
    await invoke("cox:settings-open", next, "/settings/general");
    await invoke("cox:usage-open", next, "/usage");
    next.destroy();
    expect(pages("settings")).toHaveLength(0);
    expect(pages("usage")).toHaveLength(0);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("destroys a page whose owner closes before its load resolves", async () => {
    await start();
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const owner = satellites()[0]!;
    const loading = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    fixture.loadURL.mockImplementation(async (url) => {
      if (!url.endsWith("/usage")) return;
      reached.resolve();
      await loading.promise;
    });
    const pending = invoke("cox:usage-open", owner, "/usage");
    await reached.promise;
    const usage = pages("usage")[0]!;
    owner.destroy();
    loading.resolve();
    await pending;
    expect(usage.destroyed).toBe(true);
    expect(pages("usage")).toHaveLength(0);
  });

  it("starts a fresh client-only app in a separate restricted connection window", async () => {
    await start();
    expect(primary().visible).toBe(false);
    expect(primary().webContents.getURL()).toBe("about:blank");
    expect(manager().visible).toBe(true);
    expect(decodeURIComponent(manager().webContents.getURL())).toContain('id="cox-connections"');
    expect(decodeURIComponent(manager().webContents.getURL())).toContain('type="checkbox" checked');
    expect(manager().options.webPreferences?.additionalArguments).toContain("--cox-remote=true");
    expect(fixture.launchBackend).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "saves choice %s without connecting and restores it on reopen",
    async (choice) => {
      fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
      await start();
      const local = primary();
      await invoke("cox:connections-show", local);
      const target = manager();
      const previousUrl = target.webContents.getURL();
      await invoke("cox:connections-new-window", target, !choice);
      await invoke("cox:connections-new-window", target, choice);
      expect(target.webContents.getURL()).toBe(previousUrl);
      expect(fixture.inspect).not.toHaveBeenCalled();
      expect(JSON.parse(fixture.files.get(connectionsFile)!)).toMatchObject({
        active: { kind: "local" },
        profiles: [],
        openInNewWindow: choice,
      });
      target.close();
      await invoke("cox:connections-show", local);
      const page = decodeURIComponent(manager().webContents.getURL());
      expect(page.includes('type="checkbox" checked')).toBe(choice);
      expect(local.webContents.getURL()).toBe(localOrigin);
    },
  );

  it.each([false, true])("restores saved choice %s when starting the client", async (choice) => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({ version: 1, active: null, profiles: [], openInNewWindow: choice }),
    );
    await start();
    const page = decodeURIComponent(manager().webContents.getURL());
    expect(page.includes('type="checkbox" checked')).toBe(choice);
    expect(primary().visible).toBe(false);
    expect(fixture.launchBackend).not.toHaveBeenCalled();
  });

  it("keeps the saved unchecked choice after a failed connection refreshes Connections", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-new-window", target, false);
    fixture.inspect.mockRejectedValueOnce(new Error("Remote server is unavailable"));
    await invoke("cox:connections-connect", target, {
      name: 'Office <"West"> & Co',
      origin: inspection.origin,
      openInNewWindow: false,
    });
    expect(manager()).toBe(target);
    const page = decodeURIComponent(target.webContents.getURL());
    expect(page).toContain("Remote server is unavailable");
    expect(page).toContain('value="Office &lt;&quot;West&quot;&gt; &amp; Co"');
    expect(page).toContain(`value="${inspection.origin}"`);
    expect(page).not.toContain('type="checkbox" checked');
  });

  it("does not let the new-window preference change startup restoration of the main remote", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
        openInNewWindow: true,
      }),
    );
    await start();
    expect(primary().visible).toBe(true);
    expect(primary().webContents.getURL()).toBe(inspection.origin);
    expect(fixture.windows.filter((value) => !value.destroyed)).toHaveLength(1);
    expect(JSON.parse(fixture.files.get(connectionsFile)!)).toMatchObject({
      active: { kind: "remote", profileId: saved.id },
      openInNewWindow: true,
    });
  });

  it.each([null, "false", 0, {}, undefined])(
    "rejects an invalid new-window preference %j",
    async (choice) => {
      await start();
      expect(() => invoke("cox:connections-new-window", manager(), choice)).toThrow(
        "Invalid connection preference request.",
      );
      expect(fixture.files.has(connectionsFile)).toBe(false);
    },
  );

  it("restricts new-window preference writes to the connection manager main frame", async () => {
    await start();
    expect(() => invoke("cox:connections-new-window", primary(), false)).toThrow(
      "Invalid connection preference request.",
    );
    const target = manager();
    const handler = fixture.handlers.get("cox:connections-new-window")!;
    expect(() =>
      handler(
        { sender: target.webContents, senderFrame: { url: target.webContents.getURL() } },
        false,
      ),
    ).toThrow("Invalid connection preference request.");
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const satellite = fixture.windows.find((value) =>
      value.options.webPreferences?.additionalArguments?.includes("--cox-satellite=true"),
    )!;
    expect(() => invoke("cox:connections-new-window", satellite, false)).toThrow(
      "Invalid connection preference request.",
    );
    expect(JSON.parse(fixture.files.get(connectionsFile)!)).not.toMatchObject({
      openInNewWindow: false,
    });
  });

  it("reuses the connection window when reactivated instead of showing the hidden primary", async () => {
    await start();
    const target = manager();
    target.hide();
    fixture.events.emit("activate");
    fixture.events.emit("second-instance");
    expect(manager()).toBe(target);
    expect(fixture.windows).toHaveLength(2);
    expect(target.visible).toBe(true);
    expect(fixture.focused).toBe(target);
    expect(primary().visible).toBe(false);
  });

  it("keeps Connections open for repeated new-window connections without changing the main target", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const stored = JSON.parse(fixture.files.get(connectionsFile)!);
    expect(stored.active).toBe(null);
    expect(target.destroyed).toBe(false);
    expect(primary().visible).toBe(false);
    expect(target.webContents.send).toHaveBeenCalledWith(
      "cox:connection-saved",
      stored.profiles[0],
    );
    await invoke("cox:connections-connect", target, {
      id: stored.profiles[0].id,
      openInNewWindow: true,
    });
    expect(fixture.windows.filter((value) => value.visible && value !== target)).toHaveLength(2);
    expect(manager()).toBe(target);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("keeps unchecked connection switching and reveals the primary only for its server", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: false,
    });
    expect(target.destroyed).toBe(true);
    expect(primary().visible).toBe(true);
    expect(primary().webContents.getURL()).toBe(inspection.origin);
    expect(fixture.launchBackend).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.files.get(connectionsFile)!).active.kind).toBe("remote");
  });

  it("starts local mode in the main window, not in the connection window", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-local", target);
    expect(target.destroyed).toBe(true);
    expect(primary().visible).toBe(true);
    expect(primary().webContents.getURL()).toBe(localOrigin);
    expect(fixture.launchBackend).toHaveBeenCalledTimes(1);
  });

  it("preserves a running local primary and leaves its manager open for new windows", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    const local = primary();
    expect(local.webContents.getURL()).toBe(localOrigin);
    await invoke("cox:connections-show", local);
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    expect(local.visible).toBe(true);
    expect(local.webContents.getURL()).toBe(localOrigin);
    expect(target.destroyed).toBe(false);
    expect(JSON.parse(fixture.files.get(connectionsFile)!).active).toEqual({
      kind: "local",
    });
    expect(fixture.launchBackend).toHaveBeenCalledTimes(1);
  });

  it("returns a failed startup connection to its own window with no local fallback", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      }),
    );
    fixture.inspect.mockRejectedValueOnce(new Error("Remote server is unavailable"));
    await start();
    expect(primary().visible).toBe(false);
    expect(primary().webContents.getURL()).toBe("about:blank");
    expect(decodeURIComponent(manager().webContents.getURL())).toContain(
      "Remote server is unavailable",
    );
    expect(fixture.launchBackend).not.toHaveBeenCalled();
  });

  it("hides a failed main-page load and opens Connections separately after successful preflight", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      }),
    );
    fixture.loadURL.mockImplementation(async (url) => {
      if (url === inspection.origin) throw new Error("Remote page failed to load");
    });
    await start();
    expect(primary().visible).toBe(false);
    expect(primary().webContents.getURL()).toBe("about:blank");
    expect(decodeURIComponent(manager().webContents.getURL())).toContain(
      "Remote page failed to load",
    );
    expect(fixture.launchBackend).not.toHaveBeenCalled();
  });

  it("forgets the main remote server without replacing or closing its connection window", async () => {
    fixture.files.set(
      connectionsFile,
      JSON.stringify({
        version: 1,
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      }),
    );
    await start();
    await invoke("cox:connections-show", primary());
    const target = manager();
    await invoke("cox:connections-forget", target, saved.id);
    expect(manager()).toBe(target);
    expect(target.destroyed).toBe(false);
    expect(primary().visible).toBe(false);
    expect(primary().webContents.getURL()).toBe("about:blank");
    expect(decodeURIComponent(target.webContents.getURL())).not.toContain(saved.name);
    expect(JSON.parse(fixture.files.get(connectionsFile)!)).toMatchObject({
      active: null,
      profiles: [],
    });
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("does not quit with satellite windows alive and reopens Connections on activation", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    target.close();
    expect(fixture.quit).not.toHaveBeenCalled();
    fixture.events.emit("activate");
    await fixture.started;
    expect(manager()).not.toBe(target);
    expect(primary().visible).toBe(false);
  });

  it("continues using the retained manager after its original remote owner has closed", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    const satellite = fixture.windows.find((value) =>
      value.options.webPreferences?.additionalArguments?.includes("--cox-satellite=true"),
    )!;
    await invoke("cox:connections-show", satellite);
    satellite.destroy();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    expect(target.destroyed).toBe(false);
    expect(fixture.windows.filter((value) => !value.destroyed && value.visible)).toHaveLength(2);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("cancels a pending new window when Connections closes without disturbing the local primary", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    await start();
    const local = primary();
    await invoke("cox:connections-show", local);
    const target = manager();
    const loading = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    fixture.loadURL.mockImplementation(async (url) => {
      if (url !== inspection.origin) return;
      reached.resolve();
      await loading.promise;
    });
    const pending = invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    await reached.promise;
    target.close();
    loading.resolve();
    await pending;
    expect(fixture.windows.filter((value) => !value.destroyed)).toEqual([local]);
    expect(local.webContents.getURL()).toBe(localOrigin);
    expect(local.visible).toBe(true);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("returns to Connections instead of quitting when the last satellite closes with no active primary", async () => {
    await start();
    const target = manager();
    await invoke("cox:connections-connect", target, {
      origin: inspection.origin,
      openInNewWindow: true,
    });
    target.close();
    fixture.windows.find((value) => !value.destroyed && value.visible)?.close();
    expect(fixture.quit).not.toHaveBeenCalled();
    if (process.platform !== "darwin") expect(manager()).not.toBe(target);
  });

  it("quits instead of leaving an invisible process when the last manager-only window closes", async () => {
    await start();
    manager().close();
    expect(fixture.quit).toHaveBeenCalledTimes(process.platform === "darwin" ? 0 : 1);
  });

  it("does not accept connection management from a hidden blank primary or another frame", async () => {
    await start();
    expect(() =>
      invoke("cox:connections-connect", primary(), { origin: inspection.origin }),
    ).toThrow("Invalid remote connection request");
    const target = manager();
    const handler = fixture.handlers.get("cox:connections-connect")!;
    expect(() =>
      handler(
        { sender: target.webContents, senderFrame: { url: target.webContents.getURL() } },
        { origin: inspection.origin },
      ),
    ).toThrow("Invalid remote connection request");
    expect(fixture.inspect).not.toHaveBeenCalled();
  });

  it.each([
    "{",
    JSON.stringify({
      version: 1,
      active: { kind: "remote", profileId: saved.id },
      profiles: [],
    }),
  ])("recovers malformed connection settings into a usable manager", async (contents) => {
    fixture.files.set(connectionsFile, contents);
    await import("./main.ts");
    await fixture.started;
    expect(fixture.quit).not.toHaveBeenCalled();
    expect(fixture.errors).not.toHaveBeenCalled();
    const backup = [...fixture.files.keys()].find((path) =>
      path.startsWith(connectionsFile + ".invalid-"),
    );
    expect(backup).toBeDefined();
    expect(fixture.files.get(backup!)).toBe(contents);
    const target = manager();
    expect(target.visible).toBe(true);
    expect(decodeURIComponent(target.webContents.getURL())).toContain(
      "Cox could not read the saved connection settings.",
    );
    await invoke("cox:connections-local", target);
    expect(primary().webContents.getURL()).toBe(localOrigin);
    expect(fixture.quit).not.toHaveBeenCalled();
  });

  it("keeps a remote session alive after the inactive local backend exits and can restart local", async () => {
    fixture.files.set(backendMetadataFile, JSON.stringify({ coxVersion: "0.1.60" }));
    fixture.launchBackend.mockImplementationOnce(async (start) =>
      start(resolve("/fixture/backend")),
    );
    await start();
    await invoke("cox:connections-show", primary());
    await invoke("cox:connections-connect", manager(), {
      origin: inspection.origin,
      openInNewWindow: false,
    });
    const remote = primary();
    expect(remote.webContents.getURL()).toBe(inspection.origin);
    expect(fixture.backendExit).toBeTypeOf("function");
    fixture.backendExit!("The local backend stopped");
    expect(remote.destroyed).toBe(false);
    expect(remote.visible).toBe(true);
    expect(fixture.errors).not.toHaveBeenCalled();
    expect(fixture.quit).not.toHaveBeenCalled();
    await invoke("cox:connections-show", remote);
    await invoke("cox:connections-local", manager());
    expect(primary().webContents.getURL()).toBe(localOrigin);
    expect(fixture.launchBackend).toHaveBeenCalledTimes(2);
  });

  it("rejects a remote connection while a local launch is pending", async () => {
    await start();
    const target = manager();
    const launching = Promise.withResolvers<string>();
    fixture.launchBackend.mockImplementationOnce(() => launching.promise);
    const local = invoke("cox:connections-local", target);
    await vi.waitFor(() => expect(fixture.launchBackend).toHaveBeenCalledOnce());
    try {
      await expect(
        invoke("cox:connections-connect", target, { origin: inspection.origin }),
      ).rejects.toThrow("already in progress");
      expect(fixture.inspect).not.toHaveBeenCalled();
    } finally {
      launching.resolve(localOrigin);
      await local;
    }
  });

  it("rejects a local connection while remote inspection is pending", async () => {
    await start();
    const target = manager();
    const inspecting = Promise.withResolvers<typeof inspection>();
    fixture.inspect.mockImplementationOnce(() => inspecting.promise);
    const remote = invoke("cox:connections-connect", target, { origin: inspection.origin });
    await vi.waitFor(() => expect(fixture.inspect).toHaveBeenCalledOnce());
    try {
      await expect(invoke("cox:connections-local", target)).rejects.toThrow("already in progress");
      expect(fixture.launchBackend).not.toHaveBeenCalled();
    } finally {
      inspecting.resolve(inspection);
      await remote;
    }
  });

  it.each(["storage", "persistence"])(
    "preserves remote windows and selection when Forget %s cleanup fails",
    async (failure) => {
      fixture.files.set(
        connectionsFile,
        JSON.stringify({
          version: 1,
          active: { kind: "remote", profileId: saved.id },
          profiles: [saved],
        }),
      );
      await start();
      const main = primary();
      await invoke("cox:connections-show", main);
      const target = manager();
      await invoke("cox:connections-connect", target, {
        id: saved.id,
        openInNewWindow: true,
      });
      const satellite = satellites()[0]!;
      if (failure === "storage")
        main.webContents.session.clearStorageData.mockRejectedValueOnce(
          new Error("Storage cleanup failed"),
        );
      else
        vi.mocked(renameSync).mockImplementationOnce(() => {
          throw new Error("Settings removal failed");
        });
      await expect(invoke("cox:connections-forget", target, saved.id)).rejects.toThrow(
        failure === "storage" ? "Storage cleanup failed" : "Settings removal failed",
      );
      expect(primary()).toBe(main);
      expect(main.visible).toBe(true);
      expect(main.webContents.getURL()).toBe(inspection.origin);
      expect(satellite.destroyed).toBe(false);
      expect(manager()).toBe(target);
      expect(JSON.parse(fixture.files.get(connectionsFile)!)).toMatchObject({
        active: { kind: "remote", profileId: saved.id },
        profiles: [saved],
      });
      expect(fixture.quit).not.toHaveBeenCalled();
    },
  );

  it("retains the escaped remote draft after the remote page fails to load", async () => {
    await start();
    const target = manager();
    fixture.loadURL.mockImplementation(async (url) => {
      if (url === inspection.origin) throw new Error("Remote page failed to load");
    });
    await invoke("cox:connections-connect", target, {
      name: 'Office <"West"> & Co',
      origin: inspection.origin + "/?first=1&second=2",
      openInNewWindow: false,
    });
    const page = decodeURIComponent(target.webContents.getURL());
    expect(page).toContain("Remote page failed to load");
    expect(page).toContain('value="Office &lt;&quot;West&quot;&gt; &amp; Co"');
    expect(page).toContain(`value="${inspection.origin}/?first=1&amp;second=2"`);
    expect(fixture.quit).not.toHaveBeenCalled();
  });
});
