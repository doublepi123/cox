import { useCallback, useSyncExternalStore } from "react";

import {
  LANGUAGE_STORAGE_KEY,
  parseLanguagePreference,
  resolveLanguage,
  translate,
  type Language,
  type LanguagePreference,
} from "./language";

export { detectDeviceLanguage, resolveLanguage, translate, LANGUAGE_STORAGE_KEY } from "./language";
export type { Language, LanguagePreference, TranslationKey } from "./language";

function readPreference(): LanguagePreference {
  if (typeof window === "undefined") return "system";
  try {
    return parseLanguagePreference(globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

let preference = readPreference();
const listeners = new Set<() => void>();

function deviceLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length > 0 ? navigator.languages : [navigator.language ?? ""];
}

export function getLanguage(): Language {
  return resolveLanguage(preference, deviceLanguages());
}

export function translateCurrent(
  key: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  return translate(getLanguage(), key, values);
}

function publishLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = getLanguage();
  for (const listener of listeners) listener();
}

export function setLanguagePreference(next: LanguagePreference): void {
  preference = parseLanguagePreference(next);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    publishLanguage();
    return;
  }
  publishLanguage();
}

export function initializeI18n(): void {
  preference = readPreference();
  publishLanguage();
}

function onStorage(event: StorageEvent) {
  if (event.key !== LANGUAGE_STORAGE_KEY && event.key !== null) return;
  preference = readPreference();
  publishLanguage();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    window.addEventListener("languagechange", publishLanguage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("languagechange", publishLanguage);
    }
  };
}

function snapshot(): string {
  return `${preference}:${getLanguage()}`;
}

export function useTranslation() {
  const state = useSyncExternalStore(subscribe, snapshot, () => "system:en");
  const [languagePreference, language] = state.split(":") as [LanguagePreference, Language];
  const t = useCallback(
    (key: string, values?: Readonly<Record<string, string | number>>) =>
      translate(language, key, values),
    [language],
  );
  return {
    language,
    languagePreference,
    setLanguagePreference,
    t,
  };
}
