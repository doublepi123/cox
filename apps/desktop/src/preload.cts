import type {
  DesktopShellBridge,
  DesktopWindowState,
  DesktopBackendUpdateState,
  DesktopClientUpdateState,
} from "@t3tools/contracts";

const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");
const shellBridge: DesktopShellBridge = {
  platform: process.platform,
  windowKind: process.argv.includes("--cox-window-kind=settings") ? "settings" : "main",
  openSettings: (path) => ipcRenderer.invoke("cox:settings-open", path),
  openMain: (path) => ipcRenderer.invoke("cox:main-open", path),
  onNavigate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) => listener(path);
    ipcRenderer.on("cox:navigate", handler);
    return () => ipcRenderer.removeListener("cox:navigate", handler);
  },
  closeSettings: () => ipcRenderer.send("cox:settings-close"),
  onSettingsCloseRequested: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("cox:settings-close-requested", handler);
    return () => ipcRenderer.removeListener("cox:settings-close-requested", handler);
  },
  ready: (capabilities) => ipcRenderer.send("cox:desktop-ready", capabilities),
  onQuitRequested: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, reason?: "quit" | "update") =>
      listener(reason);
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
};
const bridge: DesktopShellBridge =
  window.location.protocol === "https:"
    ? shellBridge
    : {
        ...shellBridge,
        checkUpdates: () => ipcRenderer.invoke("cox:updates-check"),
        downloadUpdates: () => ipcRenderer.invoke("cox:updates-download"),
        applyUpdates: () => ipcRenderer.invoke("cox:updates-apply"),
        setUpdatePolicy: (policy) => ipcRenderer.invoke("cox:updates-policy", policy),
        getBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-state"),
        checkBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-check"),
        installBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-install"),
        applyBackendUpdate: () => ipcRenderer.invoke("cox:backend-update-apply"),
        setBackendUpdatePolicy: (policy, version) =>
          ipcRenderer.invoke("cox:backend-update-policy", policy, version),
        onBackendUpdate: (listener) => {
          const handler = (_event: Electron.IpcRendererEvent, state: DesktopBackendUpdateState) =>
            listener(state);
          ipcRenderer.on("cox:backend-update", handler);
          ipcRenderer.send("cox:backend-update-listening");
          return () => ipcRenderer.removeListener("cox:backend-update", handler);
        },
        getClientUpdate: () => ipcRenderer.invoke("cox:client-update-state"),
        checkClientUpdate: () => ipcRenderer.invoke("cox:client-update-check"),
        downloadClientUpdate: () => ipcRenderer.invoke("cox:client-update-download"),
        applyClientUpdate: () => ipcRenderer.invoke("cox:client-update-apply"),
        setClientUpdatePolicy: (policy, version) =>
          ipcRenderer.invoke("cox:client-update-policy", policy, version),
        onClientUpdate: (listener) => {
          const handler = (_event: Electron.IpcRendererEvent, state: DesktopClientUpdateState) =>
            listener(state);
          ipcRenderer.on("cox:client-update", handler);
          return () => ipcRenderer.removeListener("cox:client-update", handler);
        },
      };
contextBridge.exposeInMainWorld("coxDesktop", bridge);

if (window.location.protocol === "data:") {
  const connections = {
    show: () => ipcRenderer.invoke("cox:connections-show"),
    useLocal: () => ipcRenderer.invoke("cox:connections-local"),
    connect: (input: { id?: string; name?: string; origin?: string }) =>
      ipcRenderer.invoke("cox:connections-connect", input),
    forget: (id: string) => ipcRenderer.invoke("cox:connections-forget", id),
  };
  contextBridge.exposeInMainWorld("coxConnections", connections);
  let busy = false;
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
  const showError = (error: unknown) => {
    const target = document.getElementById("cox-connection-error");
    if (!target) return;
    target.textContent = errorMessage(error);
    target.hidden = false;
  };
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    busy = true;
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const button of buttons) button.disabled = true;
    try {
      await action();
    } catch (error) {
      showError(error);
    } finally {
      busy = false;
      for (const button of buttons) if (button.isConnected) button.disabled = false;
    }
  };
  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("cox-open-connections")?.addEventListener("click", () => {
      void run(connections.show);
    });
    document.getElementById("cox-connection-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = document.getElementById("cox-connection-name");
      const origin = document.getElementById("cox-connection-origin");
      if (!(name instanceof HTMLInputElement) || !(origin instanceof HTMLInputElement)) return;
      void run(() => connections.connect({ name: name.value, origin: origin.value }));
    });
    document.getElementById("cox-connections")?.addEventListener("click", (event) => {
      const button =
        event.target instanceof Element ? event.target.closest("button[data-action]") : null;
      if (!(button instanceof HTMLButtonElement)) return;
      const id = button.dataset.id;
      if (button.dataset.action === "local") void run(connections.useLocal);
      if (button.dataset.action === "connect" && id) void run(() => connections.connect({ id }));
      if (button.dataset.action === "forget" && id) void run(() => connections.forget(id));
    });
  });
}

ipcRenderer.on("cox:startup-progress", (_event, state: DesktopBackendUpdateState) => {
  if (window.location.protocol !== "data:" || bridge.windowKind !== "main") return;
  const root = document.getElementById("cox-startup");
  const status = document.getElementById("cox-startup-status");
  const progressbar = document.getElementById("cox-startup-progress");
  const bar = document.getElementById("cox-startup-bar");
  const size = document.getElementById("cox-startup-size");
  const speed = document.getElementById("cox-startup-speed");
  if (!root || !status || !progressbar || !bar || !size || !speed) return;
  const progress = state.progress;
  status.textContent =
    root.dataset[
      state.status === "error"
        ? "error"
        : (progress?.phase ?? (state.status === "checking" ? "checking" : "preparing"))
    ] ?? "";
  const downloading = progress?.phase === "downloading";
  const percent =
    downloading && progress.totalBytes !== null && progress.totalBytes > 0
      ? Math.min(100, Math.floor((progress.transferredBytes / progress.totalBytes) * 100))
      : null;
  bar.classList.toggle("indeterminate", percent === null);
  bar.style.width = percent === null ? "33%" : `${percent}%`;
  if (percent === null) progressbar.removeAttribute("aria-valuenow");
  else progressbar.setAttribute("aria-valuenow", String(percent));
  const bytes = (value: number) =>
    value >= 1024 * 1024 ? `${(value / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
  size.textContent = downloading
    ? bytes(progress.transferredBytes) +
      (progress.totalBytes === null ? "" : ` / ${bytes(progress.totalBytes)} · ${percent}%`)
    : "";
  speed.textContent = downloading
    ? [
        progress.bytesPerSecond === null ? "" : `${bytes(progress.bytesPerSecond)}/s`,
        progress.remainingSeconds === null
          ? ""
          : root.dataset.remaining?.replace("{seconds}", String(progress.remainingSeconds)),
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
});
