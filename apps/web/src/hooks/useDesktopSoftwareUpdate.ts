import { useRef, useState } from "react";
import { desktopSoftwareUpdatePlan } from "@t3tools/client-runtime/state/desktop-updates";
import { useDesktopBackendUpdate } from "./useDesktopBackendUpdate";
import { useDesktopClientUpdate } from "./useDesktopClientUpdate";

export function useDesktopSoftwareUpdate() {
  const backend = useDesktopBackendUpdate();
  const client = useDesktopClientUpdate();
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const plan = desktopSoftwareUpdatePlan(backend.state, client.state);
  const execute = async (action: () => Promise<unknown>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    inFlight.current = false;
    setWorking(false);
  };
  const check = async () => {
    if (window.coxDesktop?.checkUpdates) return window.coxDesktop.checkUpdates();
    const [backendState, clientState] = await Promise.all([backend.check(), client.check()]);
    return { backend: backendState ?? backend.state, client: clientState ?? client.state };
  };
  const download = async () => {
    if (window.coxDesktop?.downloadUpdates) return window.coxDesktop.downloadUpdates();
    const state = await check();
    await Promise.all([
      state.backend?.status === "available" ? backend.install() : undefined,
      state.client?.status === "available" ? client.download() : undefined,
    ]);
  };
  return {
    backend,
    client,
    plan,
    error,
    busy: working || plan.busy,
    check: () => execute(check),
    download: () => execute(download),
    apply: () =>
      execute(async () => {
        if (plan.status !== "ready") return;
        if (window.coxDesktop?.applyUpdates) return window.coxDesktop.applyUpdates();
        if (plan.clientReady) await client.apply();
        else await backend.apply();
      }),
    setPolicy: (policy: "automatic" | "never") =>
      execute(async () => {
        if (window.coxDesktop?.setUpdatePolicy) return window.coxDesktop.setUpdatePolicy(policy);
        await Promise.all([client.setPolicy(policy), backend.setPolicy(policy)]);
      }),
  };
}
