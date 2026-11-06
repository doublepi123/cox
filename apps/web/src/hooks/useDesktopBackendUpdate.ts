import type { DesktopBackendUpdateState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export function useDesktopBackendUpdate() {
  const [state, setState] = useState<DesktopBackendUpdateState | null>(null);
  useEffect(() => {
    const bridge = window.coxDesktop;
    if (!bridge?.getBackendUpdate || !bridge.onBackendUpdate) return;
    let mounted = true;
    let received = false;
    const receive = (next: DesktopBackendUpdateState) => {
      received = true;
      if (mounted) setState(next);
    };
    const unsubscribe = bridge.onBackendUpdate(receive);
    void bridge.getBackendUpdate().then(
      (next) => {
        if (mounted && !received) setState(next);
      },
      () => {},
    );
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  const execute = async (action: (() => Promise<DesktopBackendUpdateState>) | undefined) => {
    if (!action) return;
    try {
      setState(await action());
    } catch (error) {
      setState((current) =>
        current ? { ...current, status: "error", message: String(error) } : current,
      );
    }
  };
  return {
    state,
    check: () => execute(window.coxDesktop?.checkBackendUpdate),
    install: () => execute(window.coxDesktop?.installBackendUpdate),
  };
}
