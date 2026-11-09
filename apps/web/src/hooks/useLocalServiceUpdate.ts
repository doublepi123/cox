import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalServiceUpdateState } from "@t3tools/contracts";

export function useLocalServiceUpdate(enabled: boolean) {
  const [state, setState] = useState<LocalServiceUpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const request = useCallback(async (action = "") => {
    const response = await fetch(`/api/local-service-update${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = (await response.json()) as LocalServiceUpdateState & { message?: string };
    if (!response.ok)
      throw new Error(body.message ?? `Update request failed (${response.status}).`);
    setState(body);
    return body;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void request()
        .then(
          (next) => {
            if (!active) return;
            if (next.status === "downloading" || next.status === "restarting") {
              if (!timer) timer = setInterval(load, 1_000);
            } else if (timer) {
              clearInterval(timer);
              timer = undefined;
            }
          },
          (cause) => {
            if (active) setError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          loading = false;
        });
    };
    load();
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [enabled, request]);

  const execute = async (action: "check" | "download" | "apply") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await request(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    inFlight.current = false;
    setBusy(false);
  };

  return {
    state,
    busy,
    error,
    check: () => execute("check"),
    download: () => execute("download"),
    apply: () => execute("apply"),
  };
}
