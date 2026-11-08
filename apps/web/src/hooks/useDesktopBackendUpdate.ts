import type { DesktopBackendUpdateState } from "@t3tools/contracts";
import { createDesktopUpdateStore } from "@t3tools/client-runtime/state/desktop-updates";
import { useSyncExternalStore } from "react";

const store = createDesktopUpdateStore<DesktopBackendUpdateState>((receive) => {
  const bridge = window.coxDesktop;
  if (!bridge?.getBackendUpdate || !bridge.onBackendUpdate) return;
  let active = true;
  let received = false;
  const unsubscribe = bridge.onBackendUpdate((state) => {
    received = true;
    receive(state);
  });
  void bridge.getBackendUpdate().then(
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

export function useDesktopBackendUpdate() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const execute = async (action: (() => Promise<DesktopBackendUpdateState | void>) | undefined) => {
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
    check: () => execute(window.coxDesktop?.checkBackendUpdate),
    install: () => execute(window.coxDesktop?.installBackendUpdate),
    apply: () => execute(window.coxDesktop?.applyBackendUpdate),
    setPolicy: (policy: "automatic" | "ignore-version" | "never", version?: string) => {
      const setPolicy = window.coxDesktop?.setBackendUpdatePolicy;
      return execute(setPolicy ? () => setPolicy(policy, version) : undefined);
    },
  };
}
