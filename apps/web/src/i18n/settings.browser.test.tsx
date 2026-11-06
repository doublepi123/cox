import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { ReactNode } from "react";

import { act, render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { BackgroundActivitySettingsRow } from "../components/settings/BackgroundActivitySettings";
import { BranchNamingSettings } from "../components/settings/BranchNamingSettings";
import { ChatSettingsPanel, CompactIdleThreadsRow } from "../components/settings/SettingsPanels";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { LANGUAGE_STORAGE_KEY, setLanguagePreference } from "./index";
import "../index.css";

const state = vi.hoisted(() => ({ settings: {} as UnifiedSettings, mixed: false }));

vi.mock(import("../components/settings/useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: <Selected = UnifiedSettings,>(
    selector?: (settings: UnifiedSettings) => Selected,
  ): Selected => (selector ? selector(state.settings) : (state.settings as Selected)),
  useScopedSettingsMixed: () => state.mixed,
  useUpdateScopedSettings: () => vi.fn(),
}));

vi.mock(import("../components/settings/settingsLayout"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    SettingsRow: (props) => <actual.SettingsRow {...props} serverScoped={false} />,
  };
});

function SettingsFixture({ children }: { children: ReactNode }) {
  return (
    <AppAtomRegistryProvider>
      <SettingsScopeProvider search={{}} onChange={() => undefined}>
        {children}
      </SettingsScopeProvider>
    </AppAtomRegistryProvider>
  );
}

function chineseSettings() {
  state.settings = DEFAULT_UNIFIED_SETTINGS;
  state.mixed = false;
  setLanguagePreference("zh");
  return {
    [Symbol.dispose]() {
      setLanguagePreference("system");
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    },
  };
}

it.each(["enter", "mod-enter", "mod-enter-multiline"] as const)(
  "translates both parts of the follow-up description for %s and switches live",
  async (sendShortcut) => {
    using _settings = chineseSettings();
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, sendShortcut };
    await using screen = await render(
      <SettingsFixture>
        <ChatSettingsPanel />
      </SettingsFixture>,
    );
    const row = screen.container.querySelector("#follow-up-behavior")!;
    expect(row.textContent).toContain("代理运行时将后续消息排队，或立即引导当前运行。");
    expect(row.textContent).not.toContain("Queue follow-ups");
    expect(row.textContent).not.toContain("Press ");
    expect(row.textContent).toContain("Enter");
    if (sendShortcut === "mod-enter-multiline") {
      expect(row.textContent).toContain("多行");
    }
    await act(() => setLanguagePreference("en"));
    expect(screen.container.querySelector("#follow-up-behavior")).toBe(row);
    expect(row.textContent).toContain(
      "Queue follow-ups while the agent runs or steer the current run. Press ",
    );
    await act(() => setLanguagePreference("zh"));
    expect(row.textContent).not.toContain("Queue follow-ups");
  },
);

it("translates composite background titles and advanced policy interpolation", async () => {
  using _settings = chineseSettings();
  state.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    backgroundActivity: {
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "balanced",
      overrides: { pauseWhenOnBattery: true },
    },
  };
  await using screen = await render(
    <SettingsFixture>
      <BackgroundActivitySettingsRow />
    </SettingsFixture>,
  );
  await expect.element(screen.getByRole("heading", { name: /^后台活动/ })).toBeVisible();
  expect(screen.container.textContent).toContain("使用自定义间隔。 共享策略：均衡。");
  expect(screen.container.textContent).not.toMatch(/Background activity|Uses custom|Balanced/);
  await screen.getByRole("combobox", { name: "后台活动配置" }).click();
  await expect.element(page.getByRole("option", { name: "高级（单个环境）" })).toBeVisible();
});

it("translates branch naming and compaction option labels without changing stored values", async () => {
  using _settings = chineseSettings();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, branchNamingMode: "semantic" };
  await using screen = await render(
    <SettingsFixture>
      <BranchNamingSettings />
      <CompactIdleThreadsRow />
    </SettingsFixture>,
  );
  const naming = screen.getByRole("combobox", { name: "工作树分支命名" });
  await expect.element(naming).toHaveTextContent("语义前缀");
  await naming.click();
  await expect.element(page.getByRole("option", { name: "固定前缀" })).toBeVisible();
  await expect.element(page.getByRole("option", { name: "自定义指令" })).toBeVisible();
  await userEvent.keyboard("{Escape}");
  expect(state.settings.branchNamingMode).toBe("semantic");
  expect(screen.container.textContent).not.toMatch(/When you return|Before the cache/);
  await screen.getByRole("combobox", { name: "压缩空闲对话" }).click();
  await expect.element(page.getByRole("option", { name: "返回时", exact: true })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: "缓存到期前（测试版）", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("option", { name: "从不", exact: true })).toBeVisible();
});

it("translates mixed branch naming and background profile selections", async () => {
  using _settings = chineseSettings();
  state.mixed = true;
  await using screen = await render(
    <SettingsFixture>
      <BranchNamingSettings />
      <BackgroundActivitySettingsRow />
    </SettingsFixture>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "工作树分支命名" }))
    .toHaveTextContent("不一致");
  await expect
    .element(screen.getByRole("combobox", { name: "后台活动配置" }))
    .toHaveTextContent("不一致");
});
