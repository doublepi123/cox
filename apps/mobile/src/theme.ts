import { syncNativeLauncherTheme } from "./workspace/workspacePlugin";

export const THEME_STORAGE_KEY = "cox.mobile.theme";

export type ThemePreference = "system" | "dark" | "light";

export function readThemePreference(): ThemePreference {
  const value = localStorage.getItem(THEME_STORAGE_KEY);
  return value === "dark" || value === "light" ? value : "system";
}

export function applyThemePreference(theme: ThemePreference): void {
  document.documentElement.dataset["theme"] = theme;
  document.documentElement.style.colorScheme = theme === "system" ? "light dark" : theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const resolvedColor = theme === "dark" ? "#070908" : theme === "light" ? "#f5f7f3" : null;
  void syncNativeLauncherTheme(resolvedColor);
}
