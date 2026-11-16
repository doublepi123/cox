import type { EnvironmentId, RegisteredPushSubscription } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  getCurrentBrowserPushSubscription,
  type BrowserPushSubscription,
} from "../../pwa/serviceWorkerRegistration";
import {
  browserPushSubscriptionStorageKey,
  fetchPushSubscriptions,
  registerBrowserPushSubscription,
} from "./notificationsApi";

export function useBrowserPushRegistration({
  baseUrl,
  environmentId,
  supported,
  readOnly,
  label,
}: {
  readonly baseUrl: string;
  readonly environmentId: EnvironmentId;
  readonly supported: boolean;
  readonly readOnly: boolean;
  readonly label: string;
}) {
  const [subscriptions, setSubscriptions] = useState<readonly RegisteredPushSubscription[]>([]);
  const [browserSubscription, setBrowserSubscription] = useState<BrowserPushSubscription | null>(
    null,
  );
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setLoadFailed(false);
      setCurrentId(null);
      try {
        const registered = await fetchPushSubscriptions(baseUrl);
        if (!active) return;
        setSubscriptions(registered);
        const current = supported ? await getCurrentBrowserPushSubscription() : null;
        if (!active) return;
        setBrowserSubscription(current);
        if (current) {
          const cachedId = localStorage.getItem(
            browserPushSubscriptionStorageKey(environmentId, current.endpoint),
          );
          if (registered.some((entry) => entry.id === cachedId)) setCurrentId(cachedId);
          else if (!readOnly) {
            const reconciled = await registerBrowserPushSubscription(baseUrl, current, {
              environmentId,
              label,
            });
            if (!active) return;
            setCurrentId(reconciled.id);
            setSubscriptions([
              ...registered.filter((entry) => entry.id !== reconciled.id),
              reconciled,
            ]);
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) {
          if (active) setLoading(false);
          throw error;
        }
        if (active) setLoadFailed(true);
      }
      if (active) setLoading(false);
    };
    void load();
    return () => {
      active = false;
    };
  }, [baseUrl, environmentId, supported, readOnly, label]);

  return {
    subscriptions,
    setSubscriptions,
    browserSubscription,
    setBrowserSubscription,
    setCurrentId,
    currentRegistration: subscriptions.find((entry) => entry.id === currentId),
    loading,
    loadFailed,
  };
}
