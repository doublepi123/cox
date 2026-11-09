import { readFileSync } from "node:fs";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDesktopMenuTemplate, localizeDesktopMenu } from "./native-menu.ts";

const template: MenuItemConstructorOptions[] = [
  {
    label: "Cox",
    submenu: [{ role: "about" }, { role: "hide" }, { role: "quit" }],
  },
  { role: "editMenu" },
  {
    label: "View",
    submenu: [
      { role: "reload" },
      { role: "toggleDevTools" },
      { role: "resetZoom" },
      { role: "zoomIn" },
      { role: "zoomOut" },
      { role: "togglefullscreen" },
    ],
  },
  { role: "windowMenu" },
];

function flatten(items: readonly MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : []),
  ]);
}

function menuActions() {
  return {
    openMain: vi.fn(),
    openSettings: vi.fn(),
    checkUpdates: vi.fn(),
    toggleAutomaticUpdates: vi.fn(),
    openLogs: vi.fn(),
  };
}

function submenu(item: MenuItemConstructorOptions | undefined): MenuItemConstructorOptions[] {
  expect(Array.isArray(item?.submenu)).toBe(true);
  return item!.submenu as MenuItemConstructorOptions[];
}

describe("native application menu placement", () => {
  it.each([
    ["en-US", "File", "Window", "Help"],
    ["zh-CN", "文件", "窗口", "帮助"],
  ])("uses the macOS application menu for updates in %s", (locale, file, window, help) => {
    const actions = menuActions();
    const menu = createDesktopMenuTemplate("darwin", locale, actions);
    const application = menu.find((item) => item.role === "appMenu");
    const applicationItems = submenu(application);
    const helpItems = submenu(menu.find((item) => item.role === "help"));
    const windowItems = submenu(menu.find((item) => item.role === "windowMenu"));

    expect(application?.label).toBe("Cox");
    expect(menu.some((item) => item.label === file)).toBe(false);
    expect(menu.at(-1)?.label).toBe(help);
    expect(menu.find((item) => item.role === "windowMenu")?.label).toBe(window);
    expect(applicationItems.map((item) => item.click)).toEqual(
      expect.arrayContaining([
        actions.openSettings,
        actions.checkUpdates,
        actions.toggleAutomaticUpdates,
      ]),
    );
    expect(helpItems).toHaveLength(1);
    expect(helpItems[0]?.click).toBe(actions.openLogs);
    expect(windowItems[0]?.click).toBe(actions.openMain);
    expect(flatten(menu).filter((item) => item.role === "quit")).toHaveLength(1);
  });

  it.each([
    ["win32", "en-US", "File", "Help"],
    ["win32", "zh-CN", "文件", "帮助"],
    ["linux", "en-US", "File", "Help"],
  ])("puts updates and diagnostics under Help on %s in %s", (platform, locale, file, help) => {
    const actions = menuActions();
    const menu = createDesktopMenuTemplate(platform, locale, actions);
    const fileItems = submenu(menu.find((item) => item.label === file));
    const helpMenu = menu.find((item) => item.role === "help");
    const helpItems = submenu(helpMenu);

    expect(menu.some((item) => item.role === "appMenu")).toBe(false);
    expect(helpMenu?.label).toBe(help);
    expect(fileItems.map((item) => item.click).filter(Boolean)).toEqual([actions.openSettings]);
    expect(helpItems.map((item) => item.click).filter(Boolean)).toEqual([
      actions.checkUpdates,
      actions.toggleAutomaticUpdates,
      actions.openLogs,
    ]);
    expect(flatten(menu).filter((item) => item.role === "quit")).toHaveLength(1);
  });

  it.each(["darwin", "win32", "linux"])(
    "retains update state hooks and shortcuts on %s",
    (platform) => {
      const actions = menuActions();
      const items = flatten(createDesktopMenuTemplate(platform, "en-US", actions));
      const check = items.filter((item) => item.id === "cox-check-updates");
      const automatic = items.filter((item) => item.id === "cox-automatic-updates");

      expect(check).toHaveLength(1);
      expect(check[0]).toMatchObject({ label: "Check for updates", click: actions.checkUpdates });
      expect(items.some((item) => item.id === "cox-client-update-install")).toBe(false);
      expect(items.some((item) => /Check for (Client|Cox) Updates/.test(item.label ?? ""))).toBe(
        false,
      );
      expect(automatic).toHaveLength(1);
      expect(automatic[0]).toMatchObject({
        type: "checkbox",
        checked: true,
        click: actions.toggleAutomaticUpdates,
      });
      expect(items.find((item) => item.click === actions.openSettings)?.accelerator).toBe(
        "CmdOrCtrl+,",
      );
    },
  );

  it("uses one localized check action and one shared automatic policy", () => {
    const items = flatten(createDesktopMenuTemplate("darwin", "zh-CN", menuActions()));
    expect(items.filter((item) => item.label === "检查更新")).toHaveLength(1);
    expect(items.filter((item) => item.label === "自动检查更新")).toHaveLength(1);
  });
});

describe("localized native menus", () => {
  it("translates default macOS roles, nested speech and substitutions without losing actions", () => {
    const items = flatten(localizeDesktopMenu(template, "zh-CN", "darwin"));
    const labels = items.map((item) => item.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "关于 Cox",
        "隐藏 Cox",
        "退出 Cox",
        "编辑",
        "撤销",
        "粘贴并匹配样式",
        "替换",
        "智能引号",
        "语音",
        "开始朗读",
        "窗口",
        "最小化",
        "缩放",
      ]),
    );
    for (const item of items) {
      if (item.role) expect(item.label).toMatch(/[\u3400-\u9fff]/);
    }
    expect(items.find((item) => item.label === "复制")?.role).toBe("copy");
    expect(items.find((item) => item.label === "开始朗读")?.role).toBe("startSpeaking");
    expect(items.find((item) => item.label === "智能引号")?.role).toBe("toggleSmartQuotes");
  });

  it("keeps English menus English and does not mutate the caller's template", () => {
    const original = structuredClone(template);
    const items = flatten(localizeDesktopMenu(template, "en-US", "darwin"));
    expect(items.map((item) => item.label)).toContain("Paste and Match Style");
    for (const item of items) expect(item.label ?? "").not.toMatch(/[\u3400-\u9fff]/);
    expect(template).toEqual(original);
  });

  it("retains accelerators, callbacks and explicit submenus", () => {
    const click = vi.fn();
    const [item] = localizeDesktopMenu(
      [{ role: "editMenu", submenu: [{ role: "copy", accelerator: "CmdOrCtrl+C", click }] }],
      "zh-TW",
      "darwin",
    );
    expect(item?.submenu).toEqual([
      { role: "copy", accelerator: "CmdOrCtrl+C", click, label: "复制" },
    ]);
  });

  it("does not add macOS-only menus to Windows", () => {
    const labels = flatten(localizeDesktopMenu(template, "zh-CN", "win32")).map(
      (item) => item.label,
    );
    expect(labels).toContain("编辑");
    expect(labels).toContain("窗口");
    expect(labels).not.toContain("语音");
    expect(labels).not.toContain("替换");
  });

  it("declares Chinese bundle localizations and checks them in the distributed DMG", () => {
    const packaging = readFileSync(new URL("../scripts/package.ts", import.meta.url), "utf8");
    const verification = readFileSync(new URL("../scripts/verify-mac.ts", import.meta.url), "utf8");
    expect(packaging).toContain('CFBundleLocalizations: ["en", "zh-Hans", "zh-Hant"]');
    expect(verification).toContain('"CFBundleLocalizations"');
    expect(verification).toContain('"zh-Hans", "zh-Hant"');
  });
});
