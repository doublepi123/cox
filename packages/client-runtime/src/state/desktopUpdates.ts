import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";

export function desktopSoftwareUpdatePlan(
  backend: DesktopBackendUpdateState | null,
  client: DesktopClientUpdateState | null,
) {
  const checking = backend?.status === "checking" || client?.status === "checking";
  const downloading = backend?.status === "installing" || client?.status === "downloading";
  const failed = backend?.status === "error" || client?.status === "error";
  const available = backend?.status === "available" || client?.status === "available";
  const ready = backend?.status === "ready" || client?.status === "ready";
  const incompatible = backend?.status === "incompatible" && client?.status !== "ready";
  const current =
    backend?.latestVersion === backend?.currentVersion &&
    (!client || client.latestVersion === client.currentVersion);
  const status = checking
    ? "checking"
    : downloading
      ? "downloading"
      : failed
        ? "error"
        : available
          ? "available"
          : incompatible
            ? "incompatible"
            : ready
              ? "ready"
              : current && backend?.latestVersion
                ? "current"
                : "idle";
  return {
    status,
    busy: checking || downloading,
    automaticChecks: backend?.automaticChecks !== false && client?.automaticChecks !== false,
    clientReady: client?.status === "ready",
    backendReady: backend?.status === "ready",
  } as const;
}

export function createDesktopUpdateStore<State>(
  connect: (receive: (state: State) => void) => (() => void) | undefined,
) {
  let snapshot: State | null = null;
  let disconnect: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const receive = (state: State) => {
    snapshot = state;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    receive,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) disconnect = connect(receive);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          disconnect?.();
          disconnect = undefined;
          snapshot = null;
        }
      };
    },
  };
}
