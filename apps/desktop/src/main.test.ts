import { EventEmitter } from "node:events";
import { basename, join, resolve } from "node:path";
import type { BrowserWindowConstructorOptions } from "electron";
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
  events: new EventEmitter(),
  started: Promise.resolve() as Promise<unknown>,
  loadURL: vi.fn(async (_url: string) => {}),
  launchBackend: vi.fn(async () => localOrigin),
  inspect: vi.fn(async (_origin: string) => inspection),
  quit: vi.fn(),
  errors: vi.fn(),
  menu: undefined as unknown,
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
  renameSync: (source: string, destination: string) => {
    fixture.files.set(destination, fixture.files.get(source)!);
    fixture.files.delete(source);
  },
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
    on: vi.fn(),
    handle: (name: string, action: (event: unknown, input?: unknown) => Promise<unknown>) =>
      fixture.handlers.set(name, action),
  },
  dialog: { showErrorBox: fixture.errors, showMessageBox: async () => ({ response: 1 }) },
  Menu: {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: (menu: unknown) => (fixture.menu = menu),
    getApplicationMenu: () => ({ getMenuItemById: () => undefined }),
  },
  net: { fetch: vi.fn() },
  screen: {},
  session: { fromPartition },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));
vi.mock("./backend.ts", () => ({ BackendProcess: vi.fn(), validateBackendInstallation: vi.fn() }));
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
    getState() {
      return {};
    }
  },
}));
vi.mock("./software-updates.ts", () => ({
  SoftwareUpdates: vi.fn(),
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
      !value.options.webPreferences?.additionalArguments?.includes("--cox-inline-settings=true"),
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
  fixture.events.removeAllListeners();
  fixture.inspect.mockReset().mockResolvedValue(inspection);
  fixture.loadURL.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

describe("desktop connection manager windows", () => {
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
      origin: inspection.origin,
      openInNewWindow: false,
    });
    expect(manager()).toBe(target);
    const page = decodeURIComponent(target.webContents.getURL());
    expect(page).toContain("Remote server is unavailable");
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
      value.options.webPreferences?.additionalArguments?.includes("--cox-inline-settings=true"),
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
      value.options.webPreferences?.additionalArguments?.includes("--cox-inline-settings=true"),
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
});
