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
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import type { Event, IpcMainEvent, MenuItemConstructorOptions } from "electron";
import { BackendProcess, validateBackendInstallation } from "./backend.ts";
import { BackendUpdates } from "./backend-updates.ts";
import { STARTUP_PAGE } from "./startup-page.ts";
import type { DesktopBackendUpdateState } from "@t3tools/contracts";
import { backendEnvironment, isBackendNavigation, isExternalNavigation } from "./config.ts";

const root = resolve(import.meta.dirname, "../../..");
const home = app.isPackaged
  ? join(homedir(), ".cox", "desktop")
  : join(root, ".cox", "desktop-dev");
mkdirSync(join(home, "browser"), { recursive: true, mode: 0o700 });
app.setPath("userData", join(home, "browser"));
app.setAppLogsPath(join(home, "logs"));
app.setName("Cox");

let window: BrowserWindow | undefined;
let backend: BackendProcess | undefined;
let approvedQuit = false;
let quitPending = false;
let desktopReady = false;
let stoppingBackend = false;
let origin: string | undefined;
let updates: BackendUpdates | undefined;
let startingBackend = true;
let rendererUpdatesReady = false;
let autoCheckStarted = false;
let lastPromptedVersion: string | null = null;
let nativeUpdatePrompt = false;

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
        title: "Cox update / Cox 更新",
        message:
          "Cox " +
          state.latestVersion +
          " is available. Download now and activate on the next launch?\n发现新版 Cox，是否下载并在下次启动时启用？",
        buttons: ["Later / 稍后", "Download / 下载"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (answer.response !== 1 || quitPending) return;
      state = await updates!.stage();
    } else if (!manual) return;
    if (!quitPending)
      await dialog.showMessageBox({
        type: state.status === "error" ? "warning" : "info",
        title: "Cox update / Cox 更新",
        message:
          state.status === "ready"
            ? "Update downloaded. It will activate the next time you open Cox.\n更新已下载，下次启动 Cox 时生效，不会中断当前任务。"
            : (state.message ?? "Cox is up to date. / Cox 已是最新版本。"),
      });
  } finally {
    nativeUpdatePrompt = false;
  }
}

function publishBackendUpdate(state: DesktopBackendUpdateState) {
  if (desktopReady && window && !window.isDestroyed()) {
    window?.webContents.send("cox:backend-update", state);
    void offerBackendUpdate(state).catch(() => {});
  }
}

function syncWindowControls() {
  if (!window || window.isDestroyed()) return;
  const fullscreen = window.isFullScreen();
  const zoomFactor = window.webContents.getZoomFactor();
  if (process.platform === "darwin" && !fullscreen)
    window.setWindowButtonPosition({ x: 16, y: Math.max(0, Math.round(26 * zoomFactor - 7)) });
  if (desktopReady) window.webContents.send("cox:window-state", { fullscreen, zoomFactor });
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
  if (desktopReady && window && !window.webContents.isCrashed()) {
    showWindow();
    window.webContents.send("cox:quit-requested");
    return;
  }
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Quit Cox / 退出 Cox",
    message:
      "Quitting stops the local backend and interrupts running agent turns and terminals.\n退出会停止本地后端，并中断正在运行的 Agent 任务和终端。",
    buttons: ["Cancel / 取消", "Quit Cox / 退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (result.response !== 1) {
    quitPending = false;
    return;
  }
  await finishQuit();
}

async function finishQuit() {
  if (stoppingBackend) return;
  stoppingBackend = true;
  try {
    await updates?.close();
    await backend?.stop();
    approvedQuit = true;
    app.quit();
  } catch (error) {
    quitPending = false;
    stoppingBackend = false;
    if (desktopReady) {
      quitPending = true;
      window?.webContents.send("cox:quit-requested");
    }
    dialog.showErrorBox("Cox could not stop its backend", String(error));
  }
}

async function openExternal(target: string) {
  if (!isExternalNavigation(target)) return;
  try {
    await shell.openExternal(target);
  } catch {
    dialog.showErrorBox("Cox", "Could not open this link in your default browser.");
  }
}

async function start() {
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
      width = Math.max(800, Math.min(3840, bounds.width));
      height = Math.max(600, Math.min(2160, bounds.height));
    }
  } catch {}
  window = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    title: "Cox",
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
    },
  });
  const isTrustedSender = (event: Pick<IpcMainEvent, "sender" | "senderFrame">) =>
    Boolean(
      window &&
      origin &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      isBackendNavigation(event.senderFrame.url, origin),
    );
  ipcMain.on("cox:desktop-ready", (event) => {
    if (!isTrustedSender(event)) return;
    desktopReady = true;
    syncWindowControls();
    if (updates) publishBackendUpdate(updates.getState());
    if (!autoCheckStarted && updates) {
      autoCheckStarted = true;
      void updates.check();
      setInterval(
        () => {
          if (desktopReady && !quitPending) void updates?.check();
        },
        6 * 60 * 60 * 1000,
      ).unref();
    }
    if (quitPending && !stoppingBackend) window?.webContents.send("cox:quit-requested");
  });
  ipcMain.on("cox:sync-window-controls", (event) => {
    if (isTrustedSender(event)) syncWindowControls();
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
  window.on("enter-full-screen", syncWindowControls);
  window.on("leave-full-screen", syncWindowControls);
  window.webContents.on("did-finish-load", syncWindowControls);
  window.webContents.on("zoom-changed", () => setImmediate(syncWindowControls));
  ipcMain.on("cox:quit-answer", (event, confirmed: unknown) => {
    if (!isTrustedSender(event) || !quitPending || stoppingBackend) return;
    if (confirmed === false) quitPending = false;
    else if (confirmed === true) void finishQuit();
  });
  ipcMain.on("cox:window-colors", (event, background: unknown, foreground: unknown) => {
    if (
      process.platform !== "win32" ||
      !isTrustedSender(event) ||
      typeof background !== "string" ||
      typeof foreground !== "string" ||
      !/^#[a-f0-9]{6}$/i.test(background) ||
      !/^#[a-f0-9]{6}$/i.test(foreground)
    )
      return;
    window?.setTitleBarOverlay({ color: background, symbolColor: foreground, height: 52 });
  });
  window.webContents.on("did-start-navigation", (_event, _url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) {
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
  const permissions = new Set<string>(["clipboard-sanitized-write", "fullscreen"]);
  window.webContents.session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      Boolean(
        origin &&
        contents === window?.webContents &&
        details.isMainFrame &&
        isBackendNavigation(details.requestingUrl ?? requestingOrigin, origin) &&
        permissions.has(permission),
      ),
  );
  window.webContents.session.setPermissionRequestHandler(
    (contents, permission, callback, details) => {
      if (
        !origin ||
        contents !== window?.webContents ||
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
          title: "Cox permission / 权限",
          message:
            permission === "clipboard-read"
              ? "Allow Cox to read your clipboard? / 允许 Cox 读取剪贴板？"
              : "Allow Cox notifications? / 允许 Cox 发送通知？",
          buttons: ["Deny / 拒绝", "Allow / 允许"],
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
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Open Cox", click: showWindow },
        {
          label: "Check for Cox Updates / 检查 Cox 更新",
          click: () => {
            void updates
              ?.check(true)
              .then((state) => offerBackendUpdate(state, true))
              .catch(() => {});
          },
        },
        {
          label: "Open Logs",
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
      label: "View",
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
  if (process.platform === "win32") window.setMenuBarVisibility(false);
  await window.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(STARTUP_PAGE));
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
      })
    : {
        coxVersion: (
          JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
        ).version,
      };
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
        log.write(`${message}\n`);
        dialog.showErrorBox(
          "Cox backend stopped / 后端已停止",
          `${message}\nReopen Cox to restart. / 请重新打开 Cox。\nLogs: ${logPath}`,
        );
        approvedQuit = true;
        app.quit();
      },
    });
    return backend.start();
  };
  while (true) {
    if (approvedQuit || quitPending) return;
    try {
      origin = await updates.launch(startBackend, () => backend?.stop() ?? Promise.resolve());
      break;
    } catch (error) {
      if (approvedQuit || quitPending) return;
      log.write(String(error) + "\n");
      const answer = await dialog.showMessageBox({
        type: "error",
        title: "Cox startup / Cox 启动",
        message:
          "Cox could not start or finish its first installation. Check your connection and retry.\nCox 无法启动或完成首次安装，请检查网络后重试。\n\n" +
          String(error),
        buttons: ["Quit / 退出", "Retry / 重试"],
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (approvedQuit) {
      void updates?.close();
      return;
    }
    event.preventDefault();
    void requestQuit();
  });
  void app
    .whenReady()
    .then(start)
    .catch(async (error: unknown) => {
      if (!approvedQuit)
        dialog.showErrorBox(
          "Cox could not start / 启动失败",
          `${String(error)}\nLogs / 日志: ${join(home, "logs")}`,
        );
      try {
        await backend?.stop();
      } finally {
        approvedQuit = true;
        app.quit();
      }
    });
}
