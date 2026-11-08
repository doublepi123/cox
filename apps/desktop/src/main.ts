import { execFileSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } from "electron";
import type { Event, IpcMainEvent, MenuItemConstructorOptions } from "electron";
import { BackendProcess, validateBackendInstallation } from "./backend.ts";
import { BackendUpdates } from "./backend-updates.ts";
import { ClientUpdates } from "./client-updates.ts";
import { MacAppUpdate } from "./mac-update.ts";
import { loadMacUpdateLaunch, macUpdateInProgress } from "./mac-update-transaction.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createStartupPage } from "./startup-page.ts";
import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import {
  backendEnvironment,
  isBackendNavigation,
  isExternalNavigation,
  settingsWindowUrl,
} from "./config.ts";
import { desktopText, desktopUpdateNotice } from "./native-text.ts";
import { localizeDesktopMenu } from "./native-menu.ts";

function systemLocale() {
  return app.getPreferredSystemLanguages()[0] ?? app.getLocale();
}

function text(key: Parameters<typeof desktopText>[1], values?: Readonly<Record<string, string>>) {
  return desktopText(systemLocale(), key, values);
}

const root = resolve(import.meta.dirname, "../../..");
const home = app.isPackaged
  ? join(homedir(), ".cox", "desktop")
  : join(root, ".cox", "desktop-dev");
mkdirSync(join(home, "browser"), { recursive: true, mode: 0o700 });
app.setPath("userData", join(home, "browser"));
app.setAppLogsPath(join(home, "logs"));
app.setName("Cox");

let window: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let settingsNavigation: string | undefined;
const readyWindows = new Set<number>();
let backend: BackendProcess | undefined;
let approvedQuit = false;
let quitPending = false;
let desktopReady = false;
let supportsSettingsWindow = false;
let stoppingBackend = false;
let origin: string | undefined;
let updates: BackendUpdates | undefined;
let clientUpdates: ClientUpdates | undefined;
let updateAfterQuit = false;
let restartAfterQuit = false;
let backendRestartPrompt = false;
let recoverBackend: (() => Promise<void>) | undefined;
let macUpdateLaunch: Awaited<ReturnType<typeof loadMacUpdateLaunch>> | undefined;
let checkingMacLaunch = false;
const terminateMacLaunch = () => {
  void finishQuit();
};

async function acknowledgeMacLaunch() {
  if (!macUpdateLaunch || macUpdateLaunch.acknowledged || checkingMacLaunch) return;
  checkingMacLaunch = true;
  try {
    const deadline = performance.now() + 60_000;
    while (performance.now() < deadline) {
      if (approvedQuit || !window || window.isDestroyed()) break;
      if (
        !startingBackend &&
        (await window.webContents.executeJavaScript(
          "Boolean(document.querySelector('[data-slot=\"sidebar-wrapper\"]'))",
        ))
      ) {
        await macUpdateLaunch.ready();
        process.off("SIGTERM", terminateMacLaunch);
        return;
      }
      await delay(200);
    }
    await macUpdateLaunch.fail();
  } catch {
    await macUpdateLaunch.fail();
  }
}
let startingBackend = true;
let rendererUpdatesReady = false;
let autoCheckStarted = false;
let lastPromptedVersion: string | null = null;
let nativeUpdatePrompt = false;
let lastWindowColors = "";

async function offerBackendUpdate(state: DesktopBackendUpdateState, manual = false) {
  if (approvedQuit || quitPending || !desktopReady || nativeUpdatePrompt) return;
  if (
    !manual &&
    (rendererUpdatesReady ||
      state.status !== "available" ||
      state.latestVersion === lastPromptedVersion)
  )
    return;
  nativeUpdatePrompt = true;
  try {
    if (state.status === "available") {
      lastPromptedVersion = state.latestVersion;
      const answer = await dialog.showMessageBox({
        type: "question",
        title: text("Cox update"),
        message: text("Cox {version} is available. Download now and activate on the next launch?", {
          version: state.latestVersion ?? "",
        }),
        buttons: [text("Later"), text("Download")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1 || quitPending) return;
      state = await updates!.stage();
    } else if (!manual) return;
    if (!quitPending) {
      const answer = await dialog.showMessageBox({
        title: text("Cox update"),
        ...desktopUpdateNotice(systemLocale(), state),
      });
      if (state.status === "ready" && answer.response === 1) await applyBackendUpdate();
    }
  } catch (error) {
    if (!quitPending)
      await dialog.showMessageBox({
        title: text("Cox update"),
        ...desktopUpdateNotice(systemLocale(), {
          ...state,
          status: "error",
          message: String(error),
        }),
      });
  } finally {
    nativeUpdatePrompt = false;
  }
}

function publishBackendUpdate(state: DesktopBackendUpdateState) {
  const automatic = Menu.getApplicationMenu()?.getMenuItemById("cox-automatic-updates");
  if (automatic) automatic.checked = state.automaticChecks !== false;
  for (const target of [window, settingsWindow]) {
    if (target && !target.isDestroyed() && readyWindows.has(target.webContents.id))
      target.webContents.send("cox:backend-update", state);
  }
  if (startingBackend && window && !window.isDestroyed())
    window.webContents.send("cox:startup-progress", state);
  if (desktopReady && window && !window.isDestroyed()) {
    void offerBackendUpdate(state).catch(() => {});
  }
}

function publishClientUpdate(state: DesktopClientUpdateState) {
  const install = Menu.getApplicationMenu()?.getMenuItemById("cox-client-update-install");
  if (install) install.enabled = state.status === "ready";
  for (const target of [window, settingsWindow]) {
    if (target && !target.isDestroyed() && readyWindows.has(target.webContents.id))
      target.webContents.send("cox:client-update", state);
  }
}

async function checkClientUpdates() {
  if (!clientUpdates || quitPending) return;
  let state = await clientUpdates.check(true);
  if (supportsSettingsWindow) {
    settingsWindow?.webContents.send("cox:client-update", state);
    return;
  }
  if (state.status === "available") {
    const answer = await dialog.showMessageBox({
      type: "question",
      title: text("Check for Client Updates"),
      message: text("Cox Desktop {version} is available.", { version: state.latestVersion ?? "" }),
      buttons: [text("Later"), text("Download")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1 || quitPending) return;
    state = await clientUpdates.download();
  }
  await dialog.showMessageBox({
    type: state.status === "error" ? "error" : "info",
    title: text("Check for Client Updates"),
    message:
      state.status === "ready"
        ? text(
            "Client update downloaded. Choose Install client update from the File menu when your tasks are finished.",
          )
        : state.status === "error"
          ? text("Could not update the client.") + "\n\n" + state.message
          : text("The client is up to date."),
  });
}

function syncWindowControls(target = window) {
  if (!target || target.isDestroyed()) return;
  const fullscreen = target.isFullScreen();
  const zoomFactor = target.webContents.getZoomFactor();
  if (process.platform === "darwin" && !fullscreen)
    target.setWindowButtonPosition({ x: 16, y: Math.max(0, Math.round(26 * zoomFactor - 7)) });
  if (readyWindows.has(target.webContents.id))
    target.webContents.send("cox:window-state", { fullscreen, zoomFactor });
}

function createDesktopWindow(
  kind: "main" | "settings",
  width: number,
  height: number,
  show = true,
) {
  return new BrowserWindow({
    width,
    height,
    show,
    minWidth: 400,
    minHeight: 360,
    title: kind === "main" ? "Cox" : text("Settings"),
    ...(process.platform === "win32"
      ? {
          autoHideMenuBar: true,
          titleBarStyle: "hidden" as const,
          titleBarOverlay: { color: "#151518", symbolColor: "#eeeeee", height: 52 },
        }
      : process.platform === "darwin"
        ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 16, y: 19 } }
        : {}),
    backgroundColor: "#151518",
    icon: app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(root, "apps/web/public/icon-512.png"),
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:cox-desktop",
      additionalArguments: ["--cox-window-kind=" + kind],
    },
  });
}

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function requestQuit() {
  if (quitPending) return;
  quitPending = true;
  if (!updateAfterQuit) {
    await finishQuit();
    return;
  }
  if (desktopReady && window && !window.webContents.isCrashed()) {
    showWindow();
    window.webContents.send("cox:quit-requested", "update");
    return;
  }
  const result = await dialog.showMessageBox({
    type: "warning",
    title: text("Install client update"),
    message: text(
      "Updating the client quits Cox and interrupts running agent turns and terminals.",
    ),
    buttons: [text("Cancel"), text("Continue")],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) {
    quitPending = false;
    updateAfterQuit = false;
    return;
  }
  await finishQuit();
}

async function applyBackendUpdate() {
  if (updates?.getState().status !== "ready") throw new Error(text("The Cox update is not ready."));
  if (approvedQuit || quitPending || backendRestartPrompt) return;
  backendRestartPrompt = true;
  try {
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: text("Restart and update Cox?"),
      message: text(
        "Updating Cox restarts the app and interrupts running agent tasks and terminals.",
      ),
      buttons: [text("Cancel"), text("Restart and update")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1 || approvedQuit || quitPending) return;
    if (updates?.getState().status !== "ready")
      throw new Error(text("The Cox update is not ready."));
    restartAfterQuit = true;
    await requestQuit();
  } finally {
    backendRestartPrompt = false;
  }
}

async function finishQuit() {
  if (stoppingBackend) return;
  stoppingBackend = true;
  try {
    if (!updateAfterQuit) {
      await updates?.close();
      await clientUpdates?.close();
    }
    await backend?.stop();
    if (updateAfterQuit) {
      await clientUpdates?.apply();
      await updates?.close();
      await clientUpdates?.close();
    }
    if (restartAfterQuit)
      app.relaunch({
        args: process.argv
          .slice(1)
          .filter((argument) => !argument.startsWith("--cox-update-transaction=")),
      });
    approvedQuit = true;
    app.quit();
  } catch (error) {
    restartAfterQuit = false;
    quitPending = false;
    stoppingBackend = false;
    if (updateAfterQuit) {
      updateAfterQuit = false;
      try {
        await recoverBackend?.();
      } catch (recoveryError) {
        dialog.showErrorBox("Cox", String(recoveryError));
      }
      dialog.showErrorBox(text("Install client update"), String(error));
      return;
    }
    dialog.showErrorBox("Cox could not stop its backend", String(error));
  }
}

async function openExternal(target: string) {
  if (!isExternalNavigation(target)) return;
  try {
    await shell.openExternal(target);
  } catch {
    dialog.showErrorBox("Cox", text("Could not open this link in your default browser."));
  }
}

async function start() {
  const transactionId = app.commandLine.getSwitchValue("cox-update-transaction");
  if (app.isPackaged && process.platform === "darwin" && transactionId) {
    macUpdateLaunch = await loadMacUpdateLaunch(
      home,
      transactionId,
      resolve(process.resourcesPath, "../.."),
      app.getVersion(),
    );
    process.once("SIGTERM", terminateMacLaunch);
  }
  const logPath = join(home, "logs", "desktop.log");
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
  if (existsSync(logPath) && statSync(logPath).size > 5 * 1024 * 1024) {
    renameSync(logPath, `${logPath}.previous`);
  }
  const log = createWriteStream(logPath, { flags: "a", mode: 0o600 });
  log.on("error", () => {});
  log.write(`\nCox desktop ${app.getVersion()} starting\n`);
  const boundsPath = join(home, "window.json");
  let width = 1360;
  let height = 900;
  try {
    const bounds: unknown = JSON.parse(readFileSync(boundsPath, "utf8"));
    if (
      typeof bounds === "object" &&
      bounds &&
      "width" in bounds &&
      "height" in bounds &&
      typeof bounds.width === "number" &&
      typeof bounds.height === "number"
    ) {
      width = Math.max(400, Math.min(3840, bounds.width));
      height = Math.max(360, Math.min(2160, bounds.height));
    }
  } catch {}
  window = createDesktopWindow("main", width, height);
  const senderWindow = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) => {
    const target = [window, settingsWindow].find(
      (candidate) =>
        candidate && !candidate.isDestroyed() && candidate.webContents === event.sender,
    );
    return target &&
      origin &&
      event.senderFrame === target.webContents.mainFrame &&
      isBackendNavigation(event.senderFrame.url, origin)
      ? target
      : undefined;
  };
  const isTrustedSender = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    Boolean(senderWindow(event));
  ipcMain.on("cox:desktop-ready", (event, capabilities: unknown) => {
    const target = senderWindow(event);
    if (!target) return;
    readyWindows.add(target.webContents.id);
    if (target === window) {
      desktopReady = true;
      void acknowledgeMacLaunch();
      supportsSettingsWindow = Boolean(
        capabilities &&
        typeof capabilities === "object" &&
        "settingsWindow" in capabilities &&
        capabilities.settingsWindow === true,
      );
      prewarmSettings();
    }
    syncWindowControls(target);
    if (target === settingsWindow && settingsNavigation) {
      target.webContents.send("cox:navigate", settingsNavigation);
      settingsNavigation = undefined;
    }
    if (updates) publishBackendUpdate(updates.getState());
    if (clientUpdates) publishClientUpdate(clientUpdates.getState());
    if (!autoCheckStarted && updates) {
      autoCheckStarted = true;
      void updates.check();
      void clientUpdates?.check();
      setInterval(
        () => {
          if (desktopReady && !quitPending) {
            void updates?.check();
            void clientUpdates?.check();
          }
        },
        6 * 60 * 60 * 1000,
      ).unref();
    }
    if (quitPending && !stoppingBackend)
      window?.webContents.send("cox:quit-requested", updateAfterQuit ? "update" : "quit");
  });
  ipcMain.on("cox:sync-window-controls", (event) => {
    const target = senderWindow(event);
    if (target) syncWindowControls(target);
  });
  ipcMain.on("cox:backend-update-listening", (event) => {
    if (isTrustedSender(event)) rendererUpdatesReady = true;
  });
  for (const [channel, action] of [
    ["cox:backend-update-state", () => updates?.getState()],
    ["cox:backend-update-check", () => updates?.check(true)],
    ["cox:backend-update-install", () => updates?.stage()],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted desktop update request.");
      return action();
    });
  }
  ipcMain.handle("cox:backend-update-apply", (event) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted desktop update request.");
    return applyBackendUpdate();
  });
  ipcMain.handle("cox:backend-update-policy", (event, policy: unknown, version: unknown) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted desktop update request.");
    if (
      (policy !== "automatic" && policy !== "ignore-version" && policy !== "never") ||
      (version !== undefined && typeof version !== "string")
    )
      throw new Error("Invalid Cox update policy request.");
    return updates?.setPolicy(policy, version);
  });
  for (const [channel, action] of [
    ["cox:client-update-state", () => clientUpdates?.getState()],
    ["cox:client-update-check", () => clientUpdates?.check(true)],
    ["cox:client-update-download", () => clientUpdates?.download()],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedSender(event)) throw new Error("Untrusted client update request.");
      return action();
    });
  }
  ipcMain.handle("cox:client-update-policy", (event, policy: unknown, version: unknown) => {
    if (
      !isTrustedSender(event) ||
      !["automatic", "ignore-version", "never"].includes(String(policy)) ||
      (version !== undefined && typeof version !== "string")
    )
      throw new Error("Invalid client update policy request.");
    return clientUpdates?.setPolicy(policy as "automatic" | "ignore-version" | "never", version);
  });
  ipcMain.handle("cox:client-update-apply", async (event) => {
    if (!isTrustedSender(event) || clientUpdates?.getState().status !== "ready")
      throw new Error("The client update is not ready.");
    if (quitPending) return;
    updateAfterQuit = true;
    await requestQuit();
  });
  window.on("enter-full-screen", () => syncWindowControls());
  window.on("leave-full-screen", () => syncWindowControls());
  window.webContents.on("did-finish-load", () => syncWindowControls());
  window.webContents.on("zoom-changed", () => setImmediate(syncWindowControls));
  ipcMain.on("cox:quit-answer", (event, confirmed: unknown) => {
    if (!isTrustedSender(event) || !quitPending || stoppingBackend) return;
    if (confirmed === false) {
      quitPending = false;
      updateAfterQuit = false;
    } else if (confirmed === true) void finishQuit();
  });
  ipcMain.on("cox:window-colors", (event, background: unknown, foreground: unknown) => {
    if (
      !senderWindow(event) ||
      typeof background !== "string" ||
      typeof foreground !== "string" ||
      !/^#[a-f0-9]{6}$/i.test(background) ||
      !/^#[a-f0-9]{6}$/i.test(foreground)
    )
      return;
    const target = senderWindow(event);
    target?.setBackgroundColor(background);
    if (process.platform === "win32")
      target?.setTitleBarOverlay({ color: background, symbolColor: foreground, height: 52 });
    const serialized = JSON.stringify({ background, foreground });
    if (target === window && serialized !== lastWindowColors) {
      lastWindowColors = serialized;
      try {
        writeFileSync(join(home, "window-colors.json"), serialized, { mode: 0o600 });
      } catch {}
    }
  });
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
      if (window) readyWindows.delete(window.webContents.id);
      desktopReady = false;
      rendererUpdatesReady = false;
    }
  });
  window.on("close", (event) => {
    if (approvedQuit) return;
    event.preventDefault();
    if (process.platform === "darwin") window?.hide();
    else app.quit();
  });
  window.on("resize", () => {
    if (!window || window.isMaximized() || window.isMinimized()) return;
    const [currentWidth, currentHeight] = window.getSize();
    try {
      writeFileSync(boundsPath, JSON.stringify({ width: currentWidth, height: currentHeight }), {
        mode: 0o600,
      });
    } catch {}
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  const guardNavigation = (event: Event, target: string) => {
    if (origin && isBackendNavigation(target, origin)) return;
    event.preventDefault();
    void openExternal(target);
  };
  window.webContents.on("will-navigate", guardNavigation);
  window.webContents.on("will-redirect", guardNavigation);
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  const openSettings = async (path?: unknown, visible = true) => {
    if (!origin || quitPending) return;
    const destination = settingsWindowUrl(path ?? "/settings/general", origin);
    if (!supportsSettingsWindow) {
      await window?.loadURL(destination);
      showWindow();
      return;
    }
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      if (visible) {
        settingsWindow.show();
        settingsWindow.focus();
      }
      if (path === undefined || path === "/settings") {
        return;
      }
      if (readyWindows.has(settingsWindow.webContents.id))
        settingsWindow.webContents.send("cox:navigate", destination.slice(origin.length));
      else settingsNavigation = destination.slice(origin.length);
      return;
    }
    const boundsFile = join(home, "settings-window.json");
    let bounds = {
      width: 1040,
      height: 780,
      x: undefined as number | undefined,
      y: undefined as number | undefined,
    };
    try {
      const saved: unknown = JSON.parse(readFileSync(boundsFile, "utf8"));
      if (
        saved &&
        typeof saved === "object" &&
        "width" in saved &&
        "height" in saved &&
        typeof saved.width === "number" &&
        typeof saved.height === "number"
      ) {
        bounds.width = Math.max(400, Math.min(2560, saved.width));
        bounds.height = Math.max(360, Math.min(2160, saved.height));
        if (
          "x" in saved &&
          "y" in saved &&
          typeof saved.x === "number" &&
          typeof saved.y === "number" &&
          Number.isFinite(saved.x) &&
          Number.isFinite(saved.y)
        ) {
          const area = screen.getDisplayMatching({
            x: saved.x,
            y: saved.y,
            width: bounds.width,
            height: bounds.height,
          }).workArea;
          bounds.x = Math.max(area.x, Math.min(area.x + area.width - bounds.width, saved.x));
          bounds.y = Math.max(area.y, Math.min(area.y + area.height - bounds.height, saved.y));
        }
      }
    } catch {}
    const target = createDesktopWindow("settings", bounds.width, bounds.height, visible);
    const targetId = target.webContents.id;
    settingsWindow = target;
    if (bounds.x !== undefined && bounds.y !== undefined) target.setPosition(bounds.x, bounds.y);
    target.webContents.setWindowOpenHandler(({ url }) => {
      void openExternal(url);
      return { action: "deny" };
    });
    const guardSettingsNavigation = (event: Event, url: string) => {
      try {
        if (
          settingsWindowUrl(
            new URL(url).pathname + new URL(url).search + new URL(url).hash,
            origin!,
          ) === url
        )
          return;
      } catch {}
      event.preventDefault();
      if (!origin || !isBackendNavigation(url, origin)) void openExternal(url);
    };
    target.webContents.on("will-navigate", guardSettingsNavigation);
    target.webContents.on("will-redirect", guardSettingsNavigation);
    target.webContents.on("will-attach-webview", (event) => event.preventDefault());
    target.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) readyWindows.delete(target.webContents.id);
    });
    target.on("enter-full-screen", () => syncWindowControls(target));
    target.on("leave-full-screen", () => syncWindowControls(target));
    target.webContents.on("did-finish-load", () => syncWindowControls(target));
    target.webContents.on("zoom-changed", () => setImmediate(() => syncWindowControls(target)));
    const remember = () => {
      if (target.isMaximized() || target.isMinimized() || target.isFullScreen()) return;
      try {
        writeFileSync(boundsFile, JSON.stringify(target.getBounds()), { mode: 0o600 });
      } catch {}
    };
    target.on("resize", remember);
    target.on("move", remember);
    target.on("close", (event) => {
      if (approvedQuit || !readyWindows.has(targetId) || target.webContents.isCrashed()) return;
      event.preventDefault();
      target.webContents.send("cox:settings-close-requested");
    });
    target.on("closed", () => {
      readyWindows.delete(targetId);
      if (settingsWindow === target) settingsWindow = undefined;
      settingsNavigation = undefined;
    });
    if (process.platform === "win32") target.setMenuBarVisibility(false);
    try {
      await target.loadURL(destination);
    } catch (error) {
      if (!target.isDestroyed()) target.destroy();
      throw error;
    }
  };
  ipcMain.handle("cox:settings-open", (event, path: unknown) => {
    if (!isTrustedSender(event)) throw new Error("Untrusted settings window request.");
    return openSettings(path);
  });
  ipcMain.on("cox:settings-close", (event) => {
    if (senderWindow(event) === settingsWindow) {
      settingsWindow?.hide();
    }
  });
  ipcMain.handle("cox:main-open", (event, path: unknown) => {
    if (!isTrustedSender(event) || typeof path !== "string" || !origin)
      throw new Error("Invalid main window request.");
    const target = new URL(path, origin);
    if (!path.startsWith("/") || path.startsWith("//") || !isBackendNavigation(target.href, origin))
      throw new Error("Invalid main window path.");
    window?.webContents.send("cox:navigate", target.href.slice(origin.length));
    showWindow();
  });
  let prewarmSettingsTimer: ReturnType<typeof setTimeout> | undefined;
  function prewarmSettings() {
    if (prewarmSettingsTimer || settingsWindow || !supportsSettingsWindow) return;
    prewarmSettingsTimer = setTimeout(() => {
      prewarmSettingsTimer = undefined;
      if (settingsWindow || !origin || quitPending || approvedQuit) return;
      void openSettings("/settings/general", false).catch(() => {});
    }, 250);
    prewarmSettingsTimer.unref();
  }
  const permissions = new Set<string>(["clipboard-sanitized-write", "fullscreen"]);
  window.webContents.session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      Boolean(
        origin &&
        (contents === window?.webContents || contents === settingsWindow?.webContents) &&
        details.isMainFrame &&
        isBackendNavigation(details.requestingUrl ?? requestingOrigin, origin) &&
        permissions.has(permission),
      ),
  );
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        !origin ||
        (contents !== window?.webContents && contents !== settingsWindow?.webContents) ||
        !details.isMainFrame ||
        !isBackendNavigation(details.requestingUrl, origin)
      ) {
        callback(false);
        return;
      }
      if (permissions.has(permission)) {
        callback(true);
        return;
      }
      if (!["clipboard-read", "notifications"].includes(permission)) {
        callback(false);
        return;
      }
      void dialog
        .showMessageBox({
          type: "question",
          title: text("Cox permission"),
          message:
            permission === "clipboard-read"
              ? text("Allow Cox to read your clipboard?")
              : text("Allow Cox notifications?"),
          buttons: [text("Deny"), text("Allow")],
          defaultId: 0,
          cancelId: 0,
        })
        .then(
          (result) => {
            if (result.response === 1) permissions.add(permission);
            callback(result.response === 1);
          },
          () => callback(false),
        );
    },
  );
  const menu: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: "Cox",
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: text("Settings"),
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  void openSettings().catch(() => {});
                },
              },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: text("File"),
      submenu: [
        { label: text("Open Cox"), click: showWindow },
        ...(process.platform === "darwin"
          ? []
          : [
              {
                label: text("Settings"),
                accelerator: "CmdOrCtrl+,",
                click: () => {
                  void openSettings().catch(() => {});
                },
              },
            ]),
        {
          label: text("Check for Client Updates"),
          click: () => {
            void (supportsSettingsWindow ? openSettings("/settings/about") : Promise.resolve())
              .then(() => checkClientUpdates())
              .catch(() => {});
          },
        },
        {
          id: "cox-client-update-install",
          label: text("Install client update"),
          enabled: false,
          click: () => {
            if (clientUpdates?.getState().status !== "ready" || quitPending) return;
            updateAfterQuit = true;
            void requestQuit();
          },
        },
        {
          label: text("Check for Cox Updates"),
          click: () => {
            void updates
              ?.check(true)
              .then((state) => offerBackendUpdate(state, true))
              .catch(() => {});
          },
        },
        {
          id: "cox-automatic-updates",
          label: text("Check for Cox Updates Automatically"),
          type: "checkbox",
          checked: true,
          click: (item) => {
            void updates
              ?.setPolicy(item.checked ? "automatic" : "never")
              .then(async () => {
                if (item.checked && updates)
                  await offerBackendUpdate(await updates.check(true), true);
              })
              .catch(async (error: unknown) => {
                if (!updates) return;
                item.checked = updates.getState().automaticChecks !== false;
                await offerBackendUpdate(
                  { ...updates.getState(), status: "error", message: String(error) },
                  true,
                );
              });
          },
        },
        {
          label: text("Open Logs"),
          click: () => {
            void shell.openPath(dirname(logPath));
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    {
      label: text("View"),
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(localizeDesktopMenu(menu, systemLocale(), process.platform)),
  );
  if (process.platform === "win32") window.setMenuBarVisibility(false);
  let startupColors: { background: string; foreground: string } | undefined;
  try {
    const saved: unknown = JSON.parse(readFileSync(join(home, "window-colors.json"), "utf8"));
    if (
      saved &&
      typeof saved === "object" &&
      "background" in saved &&
      "foreground" in saved &&
      typeof saved.background === "string" &&
      typeof saved.foreground === "string"
    )
      startupColors = { background: saved.background, foreground: saved.foreground };
  } catch {}
  const startupIcon = app.isPackaged
    ? join(process.resourcesPath, "icon.png")
    : join(root, "apps/web/public/icon-512.png");
  const startupPage = createStartupPage(
    systemLocale(),
    startupColors,
    "data:image/png;base64," + readFileSync(startupIcon).toString("base64"),
  );
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(startupPage));
  const nodePath = app.isPackaged
    ? join(
        process.resourcesPath,
        "runtime",
        ...(process.platform === "win32" ? ["node.exe"] : ["bin", "node"]),
      )
    : process.env.COX_DESKTOP_NODE;
  if (!nodePath || !existsSync(nodePath))
    throw new Error(
      "A standalone Node 26 executable is required. For development, set COX_DESKTOP_NODE to its absolute path.",
    );
  let loginPath: string | undefined;
  if (process.platform === "darwin") {
    try {
      const result = execFileSync(
        process.env.SHELL || "/bin/zsh",
        ["-ilc", 'printf "\\0%s\\0" "$PATH"'],
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024 * 1024 },
      );
      loginPath = result.split("\0")[1];
    } catch {}
  }
  const preloadPath = app.isPackaged
    ? join(process.resourcesPath, "backend-parent.mjs")
    : join(import.meta.dirname, "backend-parent.js");
  const environment = backendEnvironment({
    inherited: process.env,
    runtimeDirectory: dirname(nodePath),
    homeDirectory: home,
    userHome: homedir(),
    platform: process.platform,
    ...(loginPath ? { loginPath } : {}),
  });
  const metadata = app.isPackaged
    ? (JSON.parse(readFileSync(join(process.resourcesPath, "backend.json"), "utf8")) as {
        coxVersion: string | null;
        clientAutomaticUpdates?: boolean;
        clientPublisherName?: string | null;
      })
    : {
        coxVersion: (
          JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
        ).version,
        clientAutomaticUpdates: false,
        clientPublisherName: null,
      };
  clientUpdates = new ClientUpdates({
    home,
    desktopVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    flavor: metadata.coxVersion === null ? "client-only" : "bundled",
    offline: !app.isPackaged || app.commandLine.hasSwitch("offline"),
    automaticUpdates: metadata.clientAutomaticUpdates === true,
    ...(typeof metadata.clientPublisherName === "string"
      ? { publisherName: metadata.clientPublisherName }
      : {}),
    onState: publishClientUpdate,
    ...(app.isPackaged && process.platform === "darwin"
      ? {
          macUpdater: new MacAppUpdate({
            home,
            application: resolve(process.resourcesPath, "../.."),
            node: nodePath,
            helperDirectory: import.meta.dirname,
            currentVersion: app.getVersion(),
            offline: app.commandLine.hasSwitch("offline"),
          }),
        }
      : {}),
  });
  updates = new BackendUpdates({
    development: !app.isPackaged,
    home,
    desktopVersion: app.getVersion(),
    bundledVersion: metadata.coxVersion,
    bundledDirectory: app.isPackaged
      ? join(process.resourcesPath, "server")
      : join(root, "apps/server"),
    nodeVersion: execFileSync(nodePath, ["--version"], { encoding: "utf8", timeout: 5_000 })
      .trim()
      .replace(/^v/, ""),
    node: nodePath,
    npm: app.isPackaged
      ? join(
          process.resourcesPath,
          "runtime",
          ...(process.platform === "win32" ? ["node_modules"] : ["lib", "node_modules"]),
          "npm",
          "bin",
          "npm-cli.js",
        )
      : join(dirname(nodePath), "../lib/node_modules/npm/bin/npm-cli.js"),
    environment,
    offline: !app.isPackaged || app.commandLine.hasSwitch("offline"),
    onState: publishBackendUpdate,
    validate: (directory, signal) =>
      validateBackendInstallation({
        directory,
        node: nodePath,
        preload: preloadPath,
        environment,
        signal,
      }),
  });
  let runningBackendDirectory: string | undefined;
  const startBackend = async (directory: string) => {
    if (quitPending || approvedQuit) throw new Error("Cox startup was cancelled.");
    backend = new BackendProcess({
      nodePath,
      entryPath: join(directory, "dist", "bin.mjs"),
      preloadPath,
      homeDirectory: home,
      cwd: homedir(),
      environment,
      onLog: (message) => log.write(message),
      onUnexpectedExit: (message) => {
        if (startingBackend) return;
        if (macUpdateLaunch && !macUpdateLaunch.acknowledged) {
          void macUpdateLaunch.fail().then(() => finishQuit());
          return;
        }
        log.write(`${message}\n`);
        dialog.showErrorBox(
          text("Cox backend stopped"),
          `${message}\n${text("Reopen Cox to restart.")}\n${text("Logs")}: ${logPath}`,
        );
        approvedQuit = true;
        app.quit();
      },
    });
    const backendOrigin = await backend.start();
    runningBackendDirectory = directory;
    return backendOrigin;
  };
  recoverBackend = async () => {
    if (!runningBackendDirectory) return;
    const mainPath =
      window && origin && isBackendNavigation(window.webContents.getURL(), origin)
        ? window.webContents.getURL().slice(origin.length)
        : "/";
    origin = await startBackend(runningBackendDirectory);
    await window?.loadURL(origin + mainPath);
    if (settingsWindow && !settingsWindow.isDestroyed())
      await settingsWindow.loadURL(origin + "/settings/about");
  };
  while (true) {
    if (approvedQuit || quitPending) return;
    try {
      origin = await updates.launch(startBackend, () => backend?.stop() ?? Promise.resolve());
      break;
    } catch (error) {
      if (approvedQuit || quitPending) return;
      if (macUpdateLaunch && !macUpdateLaunch.acknowledged) {
        await macUpdateLaunch.fail();
        throw error;
      }
      log.write(String(error) + "\n");
      const answer = await dialog.showMessageBox({
        type: "error",
        title: text("Cox startup"),
        message:
          text(
            "Cox could not start or finish its first installation. Check your connection and retry.",
          ) +
          "\n\n" +
          String(error),
        buttons: [text("Quit"), text("Retry")],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1) {
        await updates.close();
        await backend?.stop();
        approvedQuit = true;
        app.quit();
        return;
      }
    }
  }
  startingBackend = false;
  if (!origin) return;
  if (!approvedQuit) await window.loadURL(origin);
}

if (
  (process.platform === "darwin" &&
    app.isPackaged &&
    (await macUpdateInProgress(home, app.commandLine.getSwitchValue("cox-update-transaction")))) ||
  !app.requestSingleInstanceLock()
) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (approvedQuit) {
      void updates?.close();
      void clientUpdates?.close();
      return;
    }
    event.preventDefault();
    void requestQuit();
  });
  void app
    .whenReady()
    .then(start)
    .catch(async (error: unknown) => {
      if (macUpdateLaunch && !macUpdateLaunch.acknowledged) await macUpdateLaunch.fail();
      else if (!approvedQuit)
        dialog.showErrorBox(
          text("Cox could not start"),
          `${String(error)}\n${text("Logs")}: ${join(home, "logs")}`,
        );
      try {
        await backend?.stop();
      } finally {
        approvedQuit = true;
        app.quit();
      }
    });
}
