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
import { app, BrowserWindow, dialog, Menu, shell } from "electron";
import type { Event, MenuItemConstructorOptions } from "electron";
import { BackendProcess } from "./backend.ts";
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
let origin: string | undefined;

function showWindow() {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

async function requestQuit() {
  if (quitPending) return;
  quitPending = true;
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
  try {
    await backend?.stop();
    approvedQuit = true;
    app.quit();
  } catch (error) {
    quitPending = false;
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
    backgroundColor: "#151518",
    icon: app.isPackaged
      ? join(process.resourcesPath, "icon.png")
      : join(root, "apps/web/public/icon-512.png"),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      partition: "persist:cox-desktop",
    },
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
  await window.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Cox</title><body style="background:#151518;color:#eee;font:18px system-ui;display:grid;place-content:center;height:90vh;text-align:center"><h1>Cox</h1><p>Starting local backend… / 正在启动本地后端…</p>')}`,
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
  backend = new BackendProcess({
    nodePath,
    entryPath: app.isPackaged
      ? join(process.resourcesPath, "server", "dist", "bin.mjs")
      : join(root, "apps/server/dist/bin.mjs"),
    preloadPath: app.isPackaged
      ? join(process.resourcesPath, "backend-parent.mjs")
      : join(import.meta.dirname, "backend-parent.js"),
    homeDirectory: home,
    cwd: homedir(),
    environment: backendEnvironment({
      inherited: process.env,
      runtimeDirectory: dirname(nodePath),
      homeDirectory: home,
      userHome: homedir(),
      platform: process.platform,
      ...(loginPath ? { loginPath } : {}),
    }),
    onLog: (message) => log.write(message),
    onUnexpectedExit: (message) => {
      log.write(`${message}\n`);
      dialog.showErrorBox(
        "Cox backend stopped / 后端已停止",
        `${message}\nReopen Cox to restart. / 请重新打开 Cox。\nLogs: ${logPath}`,
      );
      approvedQuit = true;
      app.quit();
    },
  });
  origin = await backend.start();
  if (!approvedQuit) await window.loadURL(origin);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showWindow);
  app.on("activate", showWindow);
  app.on("before-quit", (event) => {
    if (approvedQuit) return;
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
