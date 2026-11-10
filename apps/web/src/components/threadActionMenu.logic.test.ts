import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  formatSnoozePresetMenuLabel,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it("localizes the thread menu and its children without translating project or branch names", () => {
    const items = buildThreadActionMenuItems(
      {
        ...baseState,
        branch: "feature/Copy",
        projectFilter: { label: "Settings", isActive: false },
        canFind: true,
        canTurnIntoProject: true,
      },
      "zh",
    );
    expect(items.map((item) => item.label)).toEqual([
      "在对话中查找",
      "在分支 feature/Copy 上新建对话",
      "置顶对话",
      "归档对话",
      "暂缓",
      "重命名对话",
      "重新生成标题",
      "标为未读",
      "仅显示项目 Settings",
      "转换为项目",
      "自动归档行为",
      "复制",
      "项目设置",
      "存档对话",
      "删除",
    ]);
    expect(items.find((item) => item.id === "snooze")?.children?.map((item) => item.label)).toEqual(
      ["1 小时后 (3:00 PM)", "自定义…"],
    );
    expect(
      items.find((item) => item.id === "auto-settle")?.children?.map((item) => item.label),
    ).toEqual(["跟随设置", "从不"]);
    expect(items.find((item) => item.id === "copy")?.children?.map((item) => item.label)).toEqual([
      "路径",
      "分支",
      "对话",
      "对话 ID",
    ]);
  });

  it("localizes reversed actions while preserving permissions", () => {
    const items = buildThreadActionMenuItems(
      {
        ...baseState,
        canOperate: false,
        isPinned: true,
        isSettled: true,
        isSnoozed: true,
        isRegeneratingTitle: true,
        projectFilter: { label: "project", isActive: true },
      },
      "zh",
    );
    expect(items.find((item) => item.id === "unpin")).toMatchObject({
      label: "取消置顶对话",
      disabled: true,
    });
    expect(items.find((item) => item.id === "unsettle")?.label).toBe("取消归档对话");
    expect(items.find((item) => item.id === "unsnooze")?.label).toBe("唤醒对话");
    expect(items.find((item) => item.id === "regenerate-title")?.label).toBe("正在重新生成…");
    expect(items.find((item) => item.id === "filter-by-project")?.label).toBe("显示所有项目");
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("draft menu localization", () => {
  it("translates both the draft actions and copy submenu", () => {
    const items = buildDraftActionMenuItems(
      { hasPath: true, hasBranch: true, hasProject: true },
      "zh",
    );
    expect(items.map((item) => item.label)).toEqual(["复制", "项目设置", "丢弃草稿"]);
    expect(items[0]?.children?.map((item) => item.label)).toEqual(["路径", "分支"]);
  });
});

describe("snooze label localization", () => {
  it.each([
    ["In 30 minutes", "30 分钟后"],
    ["In 1 hour", "1 小时后"],
    ["In 3 hours", "3 小时后"],
    ["In 1 day", "1 天后"],
    ["In 2 days", "2 天后"],
    ["Tomorrow", "明天"],
    ["Next Monday", "下周一"],
  ])("translates %s while preserving the displayed wake time", (label, translated) => {
    const preset = { ...baseState.snoozePresets[0]!, label };
    expect(formatSnoozePresetMenuLabel(preset, "zh")).toBe(`${translated} (3:00 PM)`);
    expect(formatSnoozePresetMenuLabel(preset, "en")).toBe(`${label} (3:00 PM)`);
  });
});
