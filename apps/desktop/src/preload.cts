import type { DesktopShellBridge } from "@t3tools/contracts";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const bridge: DesktopShellBridge = {
  platform: process.platform,
  ready: () => ipcRenderer.send("cox:desktop-ready"),
  onQuitRequested: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("cox:quit-requested", handler);
    return () => ipcRenderer.removeListener("cox:quit-requested", handler);
  },
  answerQuit: (confirmed) => ipcRenderer.send("cox:quit-answer", confirmed),
  setWindowColors: (background, foreground) =>
    ipcRenderer.send("cox:window-colors", background, foreground),
};
contextBridge.exposeInMainWorld("coxDesktop", bridge);
