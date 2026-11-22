import type { DesktopComputerPermission, DesktopComputerUseState } from "@t3tools/contracts";
import { createDesktopUpdateStore } from "@t3tools/client-runtime/state/desktop-updates";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

const store = createDesktopUpdateStore<DesktopComputerUseState>((receive) => {
  const bridge = window.coxDesktop;
  if (!bridge?.getComputerUse) return;
  let active = true;
  let received = false;
  const unsubscribe = bridge.onComputerUse?.((state) => {
    received = true;
    receive(state);
  });
  void bridge.getComputerUse().then(
    (state) => {
      if (active && !received) receive(state);
    },
    () => {},
  );
  return () => {
    active = false;
    unsubscribe?.();
  };
});

export function useDesktopComputerUse() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, () => null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const execute = useCallback(
    async (
      action: (() => Promise<DesktopComputerUseState | void>) | undefined,
    ): Promise<DesktopComputerUseState | null> => {
      if (!action) return null;
      setError(null);
      try {
        const next = await action();
        if (next) store.receive(next);
        return next ?? store.getSnapshot();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        return null;
      }
    },
    [],
  );
  const recheck = useCallback(async () => {
    const action = window.coxDesktop?.recheckComputerUse;
    if (!action) return null;
    setChecking(true);
    try {
      return await execute(() => action());
    } finally {
      setChecking(false);
    }
  }, []);
  useEffect(() => {
    if (!state?.supported) return;
    const onFocus = () => void recheck();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [recheck, state?.supported]);
  return {
    state,
    checking,
    error,
    recheck,
    setEnabled: (enabled: boolean) => {
      const action = window.coxDesktop?.setComputerUseEnabled;
      return execute(action ? () => action(enabled) : undefined);
    },
    openSettings: (permission: DesktopComputerPermission) => {
      const action = window.coxDesktop?.openComputerUseSettings;
      return execute(action ? () => action(permission) : undefined);
    },
    restart: () => execute(window.coxDesktop?.restartForComputerUse),
    resume: () => execute(window.coxDesktop?.resumeComputerUse),
  };
}
