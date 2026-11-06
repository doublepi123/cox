import {
  ClientSettingsSchema,
  type ClientSettings,
  type ClientSettingsPatch,
} from "@t3tools/contracts";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "cox:client-settings:v1";
export const CLIENT_SETTINGS_CHANGE_EVENT = "cox:client-settings-changed";
let observed: ClientSettings | null = null;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  observed = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  return observed;
}

export async function writeBrowserClientSettings(settings: ClientSettings): Promise<void> {
  if (!hasWindow()) {
    return;
  }

  const baseline = observed;
  const patch = Object.fromEntries(
    Object.entries(settings).filter(
      ([key, value]) =>
        !baseline ||
        JSON.stringify(value) !== JSON.stringify(baseline[key as keyof ClientSettings]),
    ),
  ) as ClientSettingsPatch;
  const write = () => {
    const latest = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
    setLocalStorageItem(
      CLIENT_SETTINGS_STORAGE_KEY,
      { ...(latest ?? settings), ...patch },
      ClientSettingsSchema,
    );
    observed = settings;
    window.dispatchEvent(new Event(CLIENT_SETTINGS_CHANGE_EVENT));
  };
  if (typeof navigator !== "undefined" && navigator.locks)
    await navigator.locks.request(CLIENT_SETTINGS_STORAGE_KEY, write);
  else write();
}
