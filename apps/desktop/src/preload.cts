import type {
  DesktopShellBridge,
  DesktopWindowState,
  DesktopBackendUpdateState,
} from "@t3tools/contracts";

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
  onWindowState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopWindowState) =>
      listener(state);
    ipcRenderer.on("cox:window-state", handler);
    return () => ipcRenderer.removeListener("cox:window-state", handler);
  },
  syncWindowControls: () => ipcRenderer.send("cox:sync-window-controls"),
  getBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-state"),
  checkBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-check"),
  installBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-install"),
  onBackendUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: DesktopBackendUpdateState) =>
      listener(state);
    ipcRenderer.on("cox:backend-update", handler);
    ipcRenderer.send("cox:backend-update-listening");
    return () => ipcRenderer.removeListener("cox:backend-update", handler);
  },
};
contextBridge.exposeInMainWorld("coxDesktop", bridge);
