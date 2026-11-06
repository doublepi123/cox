import type { MenuItemConstructorOptions } from "electron";
import { desktopText } from "./native-text.ts";

const roleLabels = {
  about: "About Cox",
  hide: "Hide Cox",
  quit: "Quit Cox",
  editMenu: "Edit",
  undo: "Undo",
  redo: "Redo",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  pasteAndMatchStyle: "Paste and Match Style",
  delete: "Delete",
  selectAll: "Select All",
  showSubstitutions: "Show Substitutions",
  toggleSmartQuotes: "Smart Quotes",
  toggleSmartDashes: "Smart Dashes",
  toggleTextReplacement: "Text Replacement",
  startSpeaking: "Start Speaking",
  stopSpeaking: "Stop Speaking",
  reload: "Reload",
  toggleDevTools: "Toggle Developer Tools",
  resetZoom: "Actual Size",
  zoomIn: "Zoom In",
  zoomOut: "Zoom Out",
  togglefullscreen: "Toggle Full Screen",
  windowMenu: "Window",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
} as const;

export function localizeDesktopMenu(
  template: readonly MenuItemConstructorOptions[],
  locale: string,
  platform: string,
): MenuItemConstructorOptions[] {
  return template.map((item) => {
    const roleLabel = item.role && roleLabels[item.role as keyof typeof roleLabels];
    let submenu = item.submenu;
    if (!submenu && item.role === "editMenu") {
      submenu = [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { role: "selectAll" },
        ...(platform === "darwin"
          ? ([
              { type: "separator" },
              {
                label: desktopText(locale, "Substitutions"),
                submenu: [
                  { role: "showSubstitutions" },
                  { type: "separator" },
                  { role: "toggleSmartQuotes" },
                  { role: "toggleSmartDashes" },
                  { role: "toggleTextReplacement" },
                ],
              },
              {
                label: desktopText(locale, "Speech"),
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ];
    } else if (!submenu && item.role === "windowMenu") {
      submenu = [
        { role: "minimize" },
        ...(platform === "darwin"
          ? ([
              { role: "zoom" },
              { type: "separator" },
              { role: "front" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ];
    }
    return {
      ...item,
      ...(roleLabel ? { label: desktopText(locale, roleLabel) } : {}),
      ...(Array.isArray(submenu)
        ? { submenu: localizeDesktopMenu(submenu, locale, platform) }
        : {}),
    };
  });
}
