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
import { app, BrowserWindow, dialog, ipcMain, Menu, net, screen, session, shell } from "electron";
import type { Event, IpcMainEvent } from "electron";
import { BackendProcess, validateBackendInstallation } from "./backend.ts";
import { BackendUpdates } from "./backend-updates.ts";
import { ClientUpdates } from "./client-updates.ts";
import { SoftwareUpdates, softwareUpdateReady } from "./software-updates.ts";
import { MacAppUpdate } from "./mac-update.ts";
import { closeDesktopUpdates } from "./update-cleanup.ts";
import { loadMacUpdateLaunch, macUpdateInProgress } from "./mac-update-transaction.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createStartupPage } from "./startup-page.ts";
import { createConnectionPage } from "./connection-page.ts";
import { DesktopConnectionStore, type RemoteConnectionProfile } from "./connections.ts";
import { inspectRemoteServer, remotePartition } from "./remote.ts";
import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import {
  backendEnvironment,
  isBackendNavigation,
  isExternalNavigation,
  settingsWindowUrl,
} from "./config.ts";
import { desktopText } from "./native-text.ts";
import { createDesktopMenuTemplate } from "./native-menu.ts";

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
let localOrigin: string | undefined;
let connectionMode: "local" | "remote" | "manager" = "manager";
let activeRemoteProfile: RemoteConnectionProfile | undefined;
let connectionStore: DesktopConnectionStore;
let localPageUrl: string | undefined;
let mainPartition = "persist:cox-desktop";
let connectionGeneration = 0;
let switchingConnections = false;
let updates: BackendUpdates | undefined;
let clientUpdates: ClientUpdates | undefined;
let softwareUpdates: SoftwareUpdates | undefined;
let updateAfterQuit = false;
let restartAfterQuit = false;
let recoverBackend: (() => Promise<void>) | undefined;
let macUpdateLaunch: Awaited<ReturnType<typeof loadMacUpdateLaunch>> | undefined;
let checkingMacLaunch = false;
let reportUpdateCleanup = (error: unknown) => {
  process.stderr.write(`Cox update cache cleanup deferred: ${String(error)}\n`);
};
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
const configuredSessions = new Set<string>();

function isRemoteContext() {
  return (
    connectionMode === "remote" ||
    (connectionMode === "manager" && activeRemoteProfile !== undefined)
  );
}

async function offerSoftwareUpdate(manual = false) {
  if (isRemoteContext()) return offerRemoteClientUpdate(manual);
  if (!softwareUpdates) return;
  if (approvedQuit || quitPending || !desktopReady || nativeUpdatePrompt) return;
  let { backend: backendState, client } = softwareUpdates.getState();
  const key = `${backendState.status}:${backendState.latestVersion}:${client.status}:${client.latestVersion}`;
  const available = backendState.status === "available" || client.status === "available";
  if (!manual && (rendererUpdatesReady || !available || key === lastPromptedVersion)) return;
  nativeUpdatePrompt = true;
  try {
    if (available) {
      lastPromptedVersion = key;
      const answer = await dialog.showMessageBox({
        type: "question",
        title: text("Software updates"),
        message: text("Software updates are available."),
        detail: updateVersions(),
        buttons: [text("Later"), text("Download")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1 || quitPending) return;
      ({ backend: backendState, client } = await softwareUpdates.download());
    } else if (!manual) return;
    if (!quitPending) {
      const ready = softwareUpdateReady({ backend: backendState, client });
      if (ready) {
        await applySoftwareUpdates();
        return;
      }
      const failed = backendState.status === "error" || client.status === "error";
      await dialog.showMessageBox({
        type: failed ? "warning" : "info",
        title: text("Software updates"),
        message: text(
          failed
            ? "Could not finish updating. Check for updates again."
            : backendState.status === "incompatible"
              ? "This Cox version requires a newer desktop client."
              : backendState.latestVersion === backendState.currentVersion &&
                  client.latestVersion === client.currentVersion
                ? "The client and Cox are up to date."
                : "No update information is available yet.",
        ),
        detail: [updateVersions(), backendState.message, client.message].filter(Boolean).join("\n"),
        buttons: [text("Continue")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
    }
  } catch (error) {
    if (!quitPending)
      await dialog.showMessageBox({
        type: "warning",
        title: text("Software updates"),
        message: text("Could not finish updating. Check for updates again."),
        detail: String(error),
      });
  } finally {
    nativeUpdatePrompt = false;
  }
}

async function offerRemoteClientUpdate(manual = false) {
  if (!clientUpdates || approvedQuit || quitPending || !desktopReady || nativeUpdatePrompt) return;
  let state = clientUpdates.getState();
  const key = `remote:${state.status}:${state.latestVersion}`;
  if (
    !manual &&
    ((state.status !== "available" && state.status !== "ready") || key === lastPromptedVersion)
  )
    return;
  nativeUpdatePrompt = true;
  try {
    if (state.status === "available") {
      lastPromptedVersion = key;
      const answer = await dialog.showMessageBox({
        type: "question",
        title: text("Software updates"),
        message: text("Software updates are available."),
        detail: `Cox Desktop ${state.currentVersion} → ${state.latestVersion ?? ""}`,
        buttons: [text("Later"), text("Download")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1 || quitPending) return;
      state = await clientUpdates.download();
    }
    if (state.status === "ready") {
      await applySoftwareUpdates();
      return;
    }
    if (manual)
      await dialog.showMessageBox({
        type: state.status === "error" ? "warning" : "info",
        title: text("Software updates"),
        message: text(
          state.status === "error"
            ? "Could not finish updating. Check for updates again."
            : state.latestVersion === state.currentVersion
              ? "The client and Cox are up to date."
              : "No update information is available yet.",
        ),
        detail: state.message ?? "",
        buttons: [text("Continue")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
  } catch (error) {
    if (!quitPending)
      await dialog.showMessageBox({
        type: "warning",
        title: text("Software updates"),
        message: text("Could not finish updating. Check for updates again."),
        detail: String(error),
      });
  } finally {
    nativeUpdatePrompt = false;
  }
}

function updateVersions() {
  const state = softwareUpdates?.getState();
  if (!state) return "";
  return [
    state.client.latestVersion && state.client.status !== "idle"
      ? `Cox Desktop ${state.client.currentVersion} → ${state.client.latestVersion}`
      : null,
    state.backend.latestVersion && state.backend.status !== "idle"
      ? `Cox ${state.backend.currentVersion ?? "—"} → ${state.backend.latestVersion}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");
}

function syncUpdatePolicy() {
  const automatic = Menu.getApplicationMenu()?.getMenuItemById("cox-automatic-updates");
  if (automatic)
    automatic.checked =
      updates?.getState().automaticChecks !== false &&
      clientUpdates?.getState().automaticChecks !== false;
}

function publishBackendUpdate(state: DesktopBackendUpdateState) {
  syncUpdatePolicy();
  if (connectionMode !== "local") return;
  for (const target of [window, settingsWindow]) {
    if (target && !target.isDestroyed() && readyWindows.has(target.webContents.id))
      target.webContents.send("cox:backend-update", state);
  }
  if (startingBackend && window && !window.isDestroyed())
    window.webContents.send("cox:startup-progress", state);
}

function publishClientUpdate(state: DesktopClientUpdateState) {
  syncUpdatePolicy();
  if (connectionMode !== "local") return;
  for (const target of [window, settingsWindow]) {
    if (target && !target.isDestroyed() && readyWindows.has(target.webContents.id))
      target.webContents.send("cox:client-update", state);
  }
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
  partition = activeRemoteProfile ? remotePartition(activeRemoteProfile.id) : "persist:cox-desktop",
) {
  const target = new BrowserWindow({
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
      partition,
      additionalArguments: ["--cox-window-kind=" + kind],
    },
  });
  if (!configuredSessions.has(partition)) {
    configuredSessions.add(partition);
    const permissions = new Set<string>(
      partition === "persist:cox-desktop"
        ? ["clipboard-sanitized-write", "fullscreen"]
        : ["fullscreen"],
    );
    target.webContents.session.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        Boolean(
          origin &&
          (contents === window?.webContents || contents === settingsWindow?.webContents) &&
          details.isMainFrame &&
          isBackendNavigation(details.requestingUrl ?? requestingOrigin, origin) &&
          permissions.has(permission),
        ),
    );
    target.webContents.session.setPermissionRequestHandler(
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
        if (
          !["clipboard-read", "clipboard-sanitized-write", "notifications"].includes(permission)
        ) {
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
                : permission === "clipboard-sanitized-write"
                  ? text("Allow Cox to write to your clipboard?")
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
  }
  return target;
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
  if (connectionMode === "local" && desktopReady && window && !window.webContents.isCrashed()) {
    showWindow();
    window.webContents.send("cox:quit-requested", "update");
    return;
  }
  const result = await dialog.showMessageBox({
    type: "warning",
    title: text("Install client update"),
    message: text(
      isRemoteContext()
        ? "Updating quits Cox. Remote agent tasks and terminals continue on the server."
        : "Updating the client quits Cox and interrupts running agent turns and terminals.",
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
  return applySoftwareUpdates();
}

async function applySoftwareUpdates() {
  if (!softwareUpdates || approvedQuit || quitPending) return;
  if (isRemoteContext()) {
    const client = clientUpdates?.getState();
    if (client?.status !== "ready") throw new Error("The client update is not ready.");
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: text("Restart and install updates?"),
      message: text("Updating quits Cox. Remote agent tasks and terminals continue on the server."),
      detail: `Cox Desktop ${client.currentVersion} → ${client.latestVersion ?? ""}`,
      buttons: [text("Cancel"), text("Restart and update")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1 || approvedQuit || quitPending) return;
    updateAfterQuit = true;
    restartAfterQuit = false;
    quitPending = true;
    await finishQuit();
    return;
  }
  await softwareUpdates.apply(
    async (state) => {
      const manual = state.client.status === "ready" && state.client.installMode === "manual";
      const answer = await dialog.showMessageBox({
        type: "warning",
        title: text("Restart and install updates?"),
        message: text("Updating quits Cox and interrupts running agent tasks and terminals."),
        detail: [
          updateVersions(),
          state.backend.status === "incompatible"
            ? text("Update the client first; Cox will be checked again after relaunch.")
            : null,
        ]
          .filter(Boolean)
          .join("\n"),
        buttons: [text("Cancel"), text(manual ? "Open installer" : "Restart and update")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return answer.response === 1 && !approvedQuit && !quitPending;
    },
    async (state) => {
      updateAfterQuit = state.client.status === "ready";
      restartAfterQuit = !updateAfterQuit;
      quitPending = true;
      await finishQuit();
    },
  );
}

async function finishQuit() {
  if (stoppingBackend) return;
  stoppingBackend = true;
  try {
    if (!updateAfterQuit) {
      await closeDesktopUpdates([updates, clientUpdates], reportUpdateCleanup);
    }
    await backend?.stop();
    if (updateAfterQuit) {
      await clientUpdates?.apply();
      await closeDesktopUpdates([updates, clientUpdates], reportUpdateCleanup);
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
      if (localOrigin)
        try {
          await recoverBackend?.();
        } catch (recoveryError) {
          dialog.showErrorBox("Cox", String(recoveryError));
        }
      dialog.showErrorBox(text("Install client update"), String(error));
      return;
    }
    dialog.showErrorBox(text("Cox could not stop its backend"), String(error));
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
  reportUpdateCleanup = (error) => {
    log.write(`Cox update cache cleanup deferred: ${String(error)}\n`);
  };
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
  const isTrustedLocalSender = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    connectionMode === "local" && isTrustedSender(event);
  const checkActiveUpdates = async () => {
    if (isRemoteContext()) await clientUpdates?.check();
    else await softwareUpdates?.check();
    await offerSoftwareUpdate();
  };
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
    if (connectionMode === "local" && updates) publishBackendUpdate(updates.getState());
    if (connectionMode === "local" && clientUpdates) publishClientUpdate(clientUpdates.getState());
    if (target === window && updates) {
      void checkActiveUpdates().catch(() => {});
      if (!autoCheckStarted) {
        autoCheckStarted = true;
        setInterval(
          () => {
            if (desktopReady && !quitPending) {
              void checkActiveUpdates().catch(() => {});
            }
          },
          6 * 60 * 60 * 1000,
        ).unref();
      }
    }
    if (connectionMode === "local" && quitPending && !stoppingBackend)
      window?.webContents.send("cox:quit-requested", updateAfterQuit ? "update" : "quit");
  });
  ipcMain.on("cox:sync-window-controls", (event) => {
    const target = senderWindow(event);
    if (target) syncWindowControls(target);
  });
  ipcMain.on("cox:backend-update-listening", (event) => {
    if (isTrustedLocalSender(event)) rendererUpdatesReady = true;
  });
  for (const [channel, action] of [
    ["cox:updates-check", () => softwareUpdates?.check(true)],
    ["cox:updates-download", () => softwareUpdates?.download()],
    ["cox:updates-apply", () => applySoftwareUpdates()],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedLocalSender(event)) throw new Error("Untrusted desktop update request.");
      return action();
    });
  }
  ipcMain.handle("cox:updates-policy", (event, policy: unknown) => {
    if (!isTrustedLocalSender(event) || (policy !== "automatic" && policy !== "never"))
      throw new Error("Invalid desktop update policy request.");
    return softwareUpdates?.setPolicy(policy);
  });
  for (const [channel, action] of [
    ["cox:backend-update-state", () => updates?.getState()],
    ["cox:backend-update-check", async () => (await softwareUpdates?.check(true))?.backend],
    ["cox:backend-update-install", async () => (await softwareUpdates?.download())?.backend],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedLocalSender(event)) throw new Error("Untrusted desktop update request.");
      return action();
    });
  }
  ipcMain.handle("cox:backend-update-apply", (event) => {
    if (!isTrustedLocalSender(event)) throw new Error("Untrusted desktop update request.");
    return applyBackendUpdate();
  });
  ipcMain.handle("cox:backend-update-policy", (event, policy: unknown, version: unknown) => {
    if (!isTrustedLocalSender(event)) throw new Error("Untrusted desktop update request.");
    if (
      (policy !== "automatic" && policy !== "ignore-version" && policy !== "never") ||
      (version !== undefined && typeof version !== "string")
    )
      throw new Error("Invalid Cox update policy request.");
    return policy === "ignore-version"
      ? updates?.setPolicy(policy, version)
      : softwareUpdates?.setPolicy(policy).then((state) => state.backend);
  });
  for (const [channel, action] of [
    ["cox:client-update-state", () => clientUpdates?.getState()],
    ["cox:client-update-check", async () => (await softwareUpdates?.check(true))?.client],
    ["cox:client-update-download", async () => (await softwareUpdates?.download())?.client],
  ] as const) {
    ipcMain.handle(channel, (event) => {
      if (!isTrustedLocalSender(event)) throw new Error("Untrusted client update request.");
      return action();
    });
  }
  ipcMain.handle("cox:client-update-policy", (event, policy: unknown, version: unknown) => {
    if (
      !isTrustedLocalSender(event) ||
      !["automatic", "ignore-version", "never"].includes(String(policy)) ||
      (version !== undefined && typeof version !== "string")
    )
      throw new Error("Invalid client update policy request.");
    return policy === "ignore-version"
      ? clientUpdates?.setPolicy(policy, version)
      : softwareUpdates?.setPolicy(policy as "automatic" | "never").then((state) => state.client);
  });
  ipcMain.handle("cox:client-update-apply", async (event) => {
    if (!isTrustedLocalSender(event) || clientUpdates?.getState().status !== "ready")
      throw new Error("The client update is not ready.");
    await applySoftwareUpdates();
  });
  function configureMainWindow() {
    const target = window;
    if (!target) return;
    target.on("enter-full-screen", () => syncWindowControls(target));
    target.on("leave-full-screen", () => syncWindowControls(target));
    target.webContents.on("did-finish-load", () => syncWindowControls(target));
    target.webContents.on("zoom-changed", () => setImmediate(() => syncWindowControls(target)));
    target.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
      if (isMainFrame && !inPlace) {
        readyWindows.delete(target.webContents.id);
        desktopReady = false;
        rendererUpdatesReady = false;
      }
    });
    target.on("close", (event) => {
      if (approvedQuit) return;
      event.preventDefault();
      if (process.platform === "darwin") target.hide();
      else app.quit();
    });
    target.on("resize", () => {
      if (target.isMaximized() || target.isMinimized()) return;
      const [currentWidth, currentHeight] = target.getSize();
      try {
        writeFileSync(boundsPath, JSON.stringify({ width: currentWidth, height: currentHeight }), {
          mode: 0o600,
        });
      } catch {}
    });
    target.webContents.setWindowOpenHandler(({ url }) => {
      void openExternal(url);
      return { action: "deny" };
    });
    const guardNavigation = (event: Event, target: string) => {
      if (localPageUrl && target === localPageUrl) return;
      if (origin && isBackendNavigation(target, origin)) return;
      event.preventDefault();
      void openExternal(target);
    };
    target.webContents.on("will-navigate", guardNavigation);
    target.webContents.on("will-redirect", guardNavigation);
    target.webContents.on("will-attach-webview", (event) => event.preventDefault());
  }
  configureMainWindow();
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
  const menu = createDesktopMenuTemplate(process.platform, systemLocale(), {
    openMain: showWindow,
    openConnections: () => {
      void showConnections();
    },
    openSettings: () => {
      void openSettings().catch(() => {});
    },
    checkUpdates: () => {
      if (isRemoteContext()) {
        void clientUpdates
          ?.check(true)
          .then(() => offerRemoteClientUpdate(true))
          .catch(() => {});
        return;
      }
      void (supportsSettingsWindow ? openSettings("/settings/about") : Promise.resolve())
        .then(() => softwareUpdates?.check(true))
        .then(() => (supportsSettingsWindow ? undefined : offerSoftwareUpdate(true)))
        .catch(() => {});
    },
    toggleAutomaticUpdates: (item) => {
      void softwareUpdates
        ?.setPolicy(item.checked ? "automatic" : "never")
        .then(async () => {
          if (item.checked) {
            if (isRemoteContext()) await clientUpdates?.check();
            else await softwareUpdates?.check();
            await offerSoftwareUpdate();
          }
        })
        .catch(async (error: unknown) => {
          syncUpdatePolicy();
          await dialog.showMessageBox({
            type: "warning",
            title: text("Software updates"),
            message: text("Could not finish updating. Check for updates again."),
            detail: String(error),
          });
        });
    },
    openLogs: () => {
      void shell.openPath(dirname(logPath));
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
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
            onCleanupError: reportUpdateCleanup,
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
  softwareUpdates = new SoftwareUpdates(updates, clientUpdates);
  syncUpdatePolicy();
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
    localOrigin = origin;
    connectionMode = "local";
    await window?.loadURL(origin + mainPath);
    if (settingsWindow && !settingsWindow.isDestroyed())
      await settingsWindow.loadURL(origin + "/settings/about");
  };
  function replaceMainWindow(partition: string) {
    const previous = window;
    if (!previous || previous.isDestroyed()) return;
    const [currentWidth = 1360, currentHeight = 900] = previous.getSize();
    readyWindows.delete(previous.webContents.id);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    settingsWindow = undefined;
    settingsNavigation = undefined;
    desktopReady = false;
    rendererUpdatesReady = false;
    supportsSettingsWindow = false;
    localPageUrl = undefined;
    origin = undefined;
    window = createDesktopWindow("main", currentWidth, currentHeight, true, partition);
    mainPartition = partition;
    configureMainWindow();
    previous.destroy();
  }

  async function loadStartupPage() {
    if (!window || window.isDestroyed()) return;
    localPageUrl = "data:text/html;charset=utf-8," + encodeURIComponent(startupPage);
    await window.loadURL(localPageUrl);
  }

  async function showConnections(error?: unknown) {
    if (!connectionStore || !window || window.isDestroyed() || approvedQuit) return;
    connectionGeneration++;
    connectionMode = "manager";
    origin = undefined;
    startingBackend = false;
    desktopReady = false;
    rendererUpdatesReady = false;
    supportsSettingsWindow = false;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    settingsWindow = undefined;
    settingsNavigation = undefined;
    const icon = "data:image/png;base64," + readFileSync(startupIcon).toString("base64");
    localPageUrl =
      "data:text/html;charset=utf-8," +
      encodeURIComponent(
        createConnectionPage(
          systemLocale(),
          connectionStore.snapshot(),
          icon,
          error === undefined ? undefined : String(error),
        ),
      );
    await window.loadURL(localPageUrl);
  }

  async function startLocal() {
    if (switchingConnections || approvedQuit || quitPending) return;
    const backendUpdates = updates;
    if (!backendUpdates) throw new Error("Cox updates are not initialized.");
    switchingConnections = true;
    const generation = ++connectionGeneration;
    try {
      activeRemoteProfile = undefined;
      if (mainPartition !== "persist:cox-desktop") replaceMainWindow("persist:cox-desktop");
      connectionMode = "local";
      if (localOrigin) {
        origin = localOrigin;
        startingBackend = false;
        localPageUrl = undefined;
        await window?.loadURL(localOrigin);
        connectionStore.setActive({ kind: "local" });
        return;
      }
      origin = undefined;
      startingBackend = true;
      await loadStartupPage();
      while (true) {
        if (generation !== connectionGeneration || approvedQuit || quitPending) return;
        try {
          const startedOrigin = await backendUpdates.launch(
            startBackend,
            () => backend?.stop() ?? Promise.resolve(),
          );
          localOrigin = startedOrigin;
          if (generation !== connectionGeneration || connectionMode !== "local") {
            await backend?.stop();
            localOrigin = undefined;
            return;
          }
          origin = startedOrigin;
          localPageUrl = undefined;
          startingBackend = false;
          if (!approvedQuit) await window?.loadURL(startedOrigin);
          connectionStore.setActive({ kind: "local" });
          break;
        } catch (error) {
          if (generation !== connectionGeneration || approvedQuit || quitPending) return;
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
            await backendUpdates.close();
            await backend?.stop();
            approvedQuit = true;
            app.quit();
            return;
          }
        }
      }
    } finally {
      if (generation === connectionGeneration) startingBackend = false;
      switchingConnections = false;
    }
  }

  async function connectRemote(input: {
    readonly id?: string;
    readonly name?: string;
    readonly origin?: string;
  }) {
    if (switchingConnections || approvedQuit || quitPending) return;
    switchingConnections = true;
    try {
      const existing = input.id ? connectionStore.profile(input.id) : undefined;
      if (input.id && !existing) throw new Error("Unknown remote server.");
      const targetOrigin = input.origin ?? existing?.origin;
      if (!targetOrigin) throw new Error("Enter an HTTPS server origin.");
      const inspection = await inspectRemoteServer(targetOrigin, (input, init) =>
        net.fetch(input instanceof URL ? input.href : input, init),
      );
      const profile = connectionStore.saveRemote(inspection, {
        ...(input.id ? { id: input.id } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
      });
      if (localOrigin && backend) {
        const answer = await dialog.showMessageBox({
          type: "warning",
          title: text("Connect to remote server"),
          message: text(
            "Switching to a remote server stops the local backend and interrupts local agent tasks and terminals.",
          ),
          buttons: [text("Cancel"), text("Continue")],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (answer.response !== 1) return;
        await backend.stop();
        localOrigin = undefined;
      }
      connectionGeneration++;
      activeRemoteProfile = profile;
      const partition = remotePartition(profile.id);
      if (mainPartition !== partition) replaceMainWindow(partition);
      connectionMode = "remote";
      origin = profile.origin;
      startingBackend = false;
      localPageUrl = undefined;
      await window?.loadURL(profile.origin);
      connectionStore.setActive({ kind: "remote", profileId: profile.id });
    } catch (error) {
      log.write(`${String(error)}\n`);
      await showConnections(error);
    } finally {
      switchingConnections = false;
    }
  }

  async function forgetRemote(id: string) {
    const profile = connectionStore.profile(id);
    if (!profile) return;
    const answer = await dialog.showMessageBox({
      type: "warning",
      title: text("Forget remote server"),
      message: text("Forget this server and clear its local session and cached data?"),
      detail: profile.origin,
      buttons: [text("Cancel"), text("Continue")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return;
    const remoteSession = session.fromPartition(remotePartition(profile.id));
    await remoteSession.clearStorageData();
    await remoteSession.clearCache();
    await remoteSession.clearAuthCache();
    connectionStore.remove(profile.id);
    if (activeRemoteProfile?.id === profile.id) activeRemoteProfile = undefined;
    await showConnections();
  }

  const connectionManagerSender = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    Boolean(
      window &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      localPageUrl &&
      event.senderFrame.url === localPageUrl,
    );
  ipcMain.handle("cox:connections-show", (event) => {
    if (!connectionManagerSender(event)) throw new Error("Untrusted connection request.");
    return showConnections();
  });
  ipcMain.handle("cox:connections-local", (event) => {
    if (!connectionManagerSender(event)) throw new Error("Untrusted connection request.");
    return startLocal();
  });
  ipcMain.handle("cox:connections-connect", (event, input: unknown) => {
    if (!connectionManagerSender(event) || typeof input !== "object" || input === null)
      throw new Error("Invalid remote connection request.");
    const value = input as Record<string, unknown>;
    if (
      (value.id !== undefined && typeof value.id !== "string") ||
      (value.name !== undefined && typeof value.name !== "string") ||
      (value.origin !== undefined && typeof value.origin !== "string")
    )
      throw new Error("Invalid remote connection request.");
    return connectRemote({
      ...(typeof value.id === "string" ? { id: value.id } : {}),
      ...(typeof value.name === "string" ? { name: value.name } : {}),
      ...(typeof value.origin === "string" ? { origin: value.origin } : {}),
    });
  });
  ipcMain.handle("cox:connections-forget", (event, id: unknown) => {
    if (!connectionManagerSender(event) || typeof id !== "string")
      throw new Error("Invalid remote connection request.");
    return forgetRemote(id);
  });

  const freshClientOnly =
    metadata.coxVersion === null && !existsSync(join(home, "backend-updates", "state.json"));
  connectionStore = new DesktopConnectionStore(home, freshClientOnly ? null : { kind: "local" });
  const active = connectionStore.snapshot().active;
  if (active?.kind === "remote") await connectRemote({ id: active.profileId });
  else if (active?.kind === "local") await startLocal();
  else await showConnections();
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
      void closeDesktopUpdates([updates, clientUpdates], reportUpdateCleanup);
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
