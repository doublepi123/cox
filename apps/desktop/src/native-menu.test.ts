import { readFileSync } from "node:fs";
import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vite-plus/test";
import { localizeDesktopMenu } from "./native-menu.ts";

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
