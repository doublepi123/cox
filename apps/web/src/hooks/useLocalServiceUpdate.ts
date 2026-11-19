import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalServiceUpdateState } from "@t3tools/contracts";
import { translateCurrent } from "../i18n";

export function useLocalServiceUpdate(enabled: boolean) {
  const [state, setState] = useState<LocalServiceUpdateState | null>(null);
  const [pending, setPending] = useState<"" | "check" | "download" | "apply" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const request = useCallback(async (action = "", signal?: AbortSignal) => {
    const response = await fetch(`/api/local-service-update${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    const body = (await response.json()) as LocalServiceUpdateState & { message?: string };
    if (!response.ok)
      throw new Error(
        body.message ??
          translateCurrent("Update request failed ({status}).", { status: response.status }),
      );
    if (!signal?.aborted) {
      setError(null);
      setState(body);
    }
    return body;
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const load = () =>
      request().catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      });
    void load();
    return () => {
      active = false;
    };
  }, [enabled, request]);

  const polling =
    pending === "download" || state?.status === "downloading" || state?.status === "restarting";
  useEffect(() => {
    if (!enabled || !polling) return;
    const controller = new AbortController();
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      void request("", controller.signal)
        .catch((cause) => {
          if (!controller.signal.aborted)
            setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => {
          loading = false;
        });
    };
    const timer = setInterval(load, 1_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [enabled, request, polling]);

  const execute = async (action: "" | "check" | "download" | "apply") => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(action);
    setError(null);
    try {
      await request(action);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    inFlight.current = false;
    setPending(null);
  };

  return {
    state,
    busy: pending !== null,
    error,
    reload: () => execute(""),
    check: () => execute("check"),
    download: () => execute("download"),
    apply: () => execute("apply"),
  };
}
