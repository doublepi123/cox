import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";
import { LANGUAGE_STORAGE_KEY, setLanguagePreference } from "../../i18n";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import type { WebPushSupportState } from "../../pwa/serviceWorkerRegistration";
import type { BrowserPushSubscription } from "../../pwa/serviceWorkerRegistration";
import { ToastProvider } from "../ui/toast";
import { EnvironmentNotificationsSettings } from "./NotificationsSettingsPanel";

const environmentId = EnvironmentId.make("env-1");
export interface NotificationTestState {
  settings: UnifiedSettings;
  support: WebPushSupportState;
  save: ReturnType<typeof vi.fn>;
  listeners: Set<() => void>;
  browserSubscription: BrowserPushSubscription | null;
  unsubscribe: ReturnType<typeof vi.fn>;
}

export function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") return new URL(input);
  return input instanceof URL ? input : new URL(input.url);
}

export function fixture(
  state: NotificationTestState,
  {
    language = "en",
    theme = "light",
    support = { supported: true } as WebPushSupportState,
  }: {
    language?: "en" | "zh";
    theme?: "light" | "dark";
    support?: WebPushSupportState;
  } = {},
) {
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.browserSubscription = null;
  state.unsubscribe.mockReset();
  state.unsubscribe.mockResolvedValue(true);
  localStorage.clear();
  state.support = support;
  state.listeners.clear();
  state.save.mockReset();
  state.save.mockImplementation(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
    const patch = input.patch.notifications;
    if (patch) {
      state.settings = {
        ...state.settings,
        notifications: {
          ...state.settings.notifications,
          ...patch,
          ...(patch.webhooks
            ? {
                webhooks: patch.webhooks.map((channel) => ({
                  ...channel,
                  secret:
                    typeof channel.secret === "string" && channel.secret
                      ? "••••••"
                      : channel.secret,
                })),
              }
            : {}),
        },
      };
      for (const listener of state.listeners) listener();
    }
    return { _tag: "Success", value: undefined };
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/notifications/push-subscriptions" && !init?.method) {
      return Response.json({ subscriptions: [] });
    }
    if (url.pathname === "/api/notifications/test" && init?.method === "POST") {
      return Response.json({ delivered: true });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.pathname}`);
  });
  const fetchResource = stubGlobal("fetch", fetchMock);
  setLanguagePreference(language);
  document.documentElement.classList.toggle("dark", theme === "dark");
  return {
    fetchMock,
    [Symbol.dispose]() {
      fetchResource[Symbol.dispose]();
      vi.restoreAllMocks();
      setLanguagePreference("system");
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      document.documentElement.classList.remove("dark");
      state.listeners.clear();
    },
  };
}

export function panel() {
  return (
    <AppAtomRegistryProvider>
      <ToastProvider timeout={0}>
        <EnvironmentNotificationsSettings environmentId={environmentId} />
      </ToastProvider>
    </AppAtomRegistryProvider>
  );
}
