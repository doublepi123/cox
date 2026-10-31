import { en } from "./en";
import { zh } from "./zh";

export type Language = "en" | "zh";
export type LanguagePreference = Language | "system";
export type TranslationKey = keyof typeof en;
export const LANGUAGE_STORAGE_KEY = "cox.language";

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return value === "en" || value === "zh" ? value : "system";
}

export function detectDeviceLanguage(languages: readonly string[]): Language {
  for (const locale of languages) {
    const language = locale.trim().toLowerCase().split(/[-_]/)[0];
    if (language === "zh" || language === "en") return language;
  }
  return "en";
}

export function resolveLanguage(
  preference: LanguagePreference,
  languages: readonly string[],
): Language {
  return preference === "system" ? detectDeviceLanguage(languages) : preference;
}

export function translate(
  language: Language,
  key: string,
  values?: Readonly<Record<string, string | number>>,
): string {
  const resources: Readonly<Record<string, string>> = language === "zh" ? zh : en;
  const template = Object.hasOwn(resources, key) ? resources[key]! : key;
  return values === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (token, name: string) =>
        Object.hasOwn(values, name) ? String(values[name]) : token,
      );
}
