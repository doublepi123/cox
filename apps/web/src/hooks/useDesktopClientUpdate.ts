import type { DesktopClientUpdateState } from "@t3tools/contracts";
import { createDesktopUpdateStore } from "@t3tools/client-runtime/state/desktop-updates";
import { useSyncExternalStore } from "react";

const store = createDesktopUpdateStore<DesktopClientUpdateState>((receive) => {
  const bridge = window.coxDesktop;
  if (!bridge?.getClientUpdate || !bridge.onClientUpdate) return;
  let active = true;
  let received = false;
  const unsubscribe = bridge.onClientUpdate((state) => {
    received = true;
    receive(state);
  });
  void bridge.getClientUpdate().then(
    (state) => {
      if (active && !received) receive(state);
    },
    () => {},
  );
  return () => {
    active = false;
    unsubscribe();
  };
});

export function useDesktopClientUpdate() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const execute = async (action: (() => Promise<DesktopClientUpdateState | void>) | undefined) => {
    if (!action) return;
    const previous = store.getSnapshot();
    try {
      const next = await action();
      if (next && store.getSnapshot() === previous) store.receive(next);
    } catch (error) {
      const current = store.getSnapshot();
      if (current)
        store.receive({ ...current, status: "error", progress: null, message: String(error) });
    }
  };
  return {
    state,
    check: () => execute(window.coxDesktop?.checkClientUpdate),
    download: () => execute(window.coxDesktop?.downloadClientUpdate),
    apply: () => execute(window.coxDesktop?.applyClientUpdate),
    setPolicy: (policy: "automatic" | "ignore-version" | "never", version?: string) => {
      const setPolicy = window.coxDesktop?.setClientUpdatePolicy;
      return execute(setPolicy ? () => setPolicy(policy, version) : undefined);
    },
  };
}
