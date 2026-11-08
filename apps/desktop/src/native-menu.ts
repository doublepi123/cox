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
  help: "Help",
  windowMenu: "Window",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
} as const;

type DesktopMenuActions = Readonly<
  Record<
    | "openMain"
    | "openSettings"
    | "checkClientUpdates"
    | "installClientUpdate"
    | "checkBackendUpdates"
    | "toggleAutomaticUpdates"
    | "openLogs",
    NonNullable<MenuItemConstructorOptions["click"]>
  >
>;

export function createDesktopMenuTemplate(
  platform: string,
  locale: string,
  actions: DesktopMenuActions,
): MenuItemConstructorOptions[] {
  const text = (key: Parameters<typeof desktopText>[1]) => desktopText(locale, key);
  const mac = platform === "darwin";
  const settings: MenuItemConstructorOptions = {
    label: text("Settings"),
    accelerator: "CmdOrCtrl+,",
    click: actions.openSettings,
  };
  const updates: MenuItemConstructorOptions[] = [
    { label: text("Check for Client Updates"), click: actions.checkClientUpdates },
    {
      id: "cox-client-update-install",
      label: text("Install client update"),
      enabled: false,
      click: actions.installClientUpdate,
    },
    { label: text("Check for Cox Updates"), click: actions.checkBackendUpdates },
    {
      id: "cox-automatic-updates",
      label: text("Check for Cox Updates Automatically"),
      type: "checkbox",
      checked: true,
      click: actions.toggleAutomaticUpdates,
    },
  ];
  const application: MenuItemConstructorOptions = mac
    ? {
        role: "appMenu",
        label: "Cox",
        submenu: [
          { role: "about" },
          { type: "separator" },
          settings,
          { type: "separator" },
          ...updates,
          { type: "separator" },
          { role: "hide" },
          { type: "separator" },
          { role: "quit" },
        ],
      }
    : {
        label: text("File"),
        submenu: [settings, { type: "separator" }, { role: "quit" }],
      };
  return localizeDesktopMenu(
    [
      application,
      { role: "editMenu" },
      {
        label: text("View"),
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
      {
        role: "windowMenu",
        submenu: [
          { label: text("Open Cox"), click: actions.openMain },
          { type: "separator" },
          { role: "minimize" },
          ...(mac
            ? ([
                { role: "zoom" },
                { type: "separator" },
                { role: "front" },
              ] satisfies MenuItemConstructorOptions[])
            : []),
        ],
      },
      {
        role: "help",
        submenu: [
          ...(!mac ? [...updates, { type: "separator" as const }] : []),
          { label: text("Open Logs"), click: actions.openLogs },
        ],
      },
    ],
    locale,
    platform,
  );
}

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
