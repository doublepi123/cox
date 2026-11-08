import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { NoProjectsHero } from "../components/NoProjectsHero";
import ChatMarkdown from "../components/ChatMarkdown";
import { LanguageSettings } from "../components/settings/LanguageSettings";
import { SettingsSidebarNav } from "../components/settings/SettingsSidebarNav";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { SidebarProvider } from "../components/ui/sidebar";
import { getLanguage, initializeI18n, LANGUAGE_STORAGE_KEY, setLanguagePreference } from "./index";
import "../index.css";

const originalContent = "Settings · Add project · Save · 用户与 Agent 原始内容";

function LanguageWorkspace() {
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <div>
          <SettingsSidebarNav pathname="/settings/general" />
          <SettingsBreadcrumb pathname="/settings/general" />
          <LanguageSettings />
          <NoProjectsHero />
          <input aria-label="Unsent user draft" defaultValue={originalContent} />
          <article aria-label="Original agent response">
            <ChatMarkdown text={originalContent} cwd={undefined} />
          </article>
        </div>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

function restoreLanguage() {
  return {
    [Symbol.dispose]() {
      vi.restoreAllMocks();
      setLanguagePreference("system");
      localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    },
  };
}

it("defaults to Chinese device language in real navigation and project UI", async () => {
  using _language = restoreLanguage();
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN", "en-US"]);
  setLanguagePreference("system");
  initializeI18n();
  await using screen = await render(<LanguageWorkspace />);
  await expect.element(screen.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("treeitem", { name: "提供商", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "添加项目", exact: true })).toBeVisible();
  await expect.element(screen.getByText("我们来做点什么？", { exact: true })).toBeVisible();
  expect(document.documentElement.lang).toBe("zh");
  expect(
    screen.getByRole("article", { name: "Original agent response" }).element().textContent,
  ).toBe(originalContent);
});

it("switches live, persists the preference, and keeps draft and agent content unchanged", async () => {
  using _language = restoreLanguage();
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  setLanguagePreference("system");
  await using screen = await render(<LanguageWorkspace />);
  const draft = screen.getByRole("textbox", { name: "Unsent user draft" }).element();
  await expect
    .element(screen.getByRole("treeitem", { name: "General", exact: true }))
    .toBeVisible();
  await screen.getByRole("combobox", { name: "Interface language" }).selectOptions("zh");
  await expect.element(screen.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("combobox", { name: "界面语言" })).toHaveValue("zh");
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh");
  expect(getLanguage()).toBe("zh");
  expect(document.documentElement.lang).toBe("zh");
  expect(screen.getByRole("textbox", { name: "Unsent user draft" }).element()).toBe(draft);
  await expect
    .element(page.getByRole("textbox", { name: "Unsent user draft" }))
    .toHaveValue(originalContent);
  expect(
    screen.getByRole("article", { name: "Original agent response" }).element().textContent,
  ).toBe(originalContent);
  await screen.unmount();
  const savedPreference = localStorage.getItem(LANGUAGE_STORAGE_KEY)!;
  setLanguagePreference("system");
  localStorage.setItem(LANGUAGE_STORAGE_KEY, savedPreference);
  initializeI18n();
  await using reloaded = await render(<LanguageWorkspace />);
  await expect.element(reloaded.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
  await reloaded.getByRole("combobox", { name: "界面语言" }).selectOptions("en");
  await expect
    .element(reloaded.getByRole("treeitem", { name: "General", exact: true }))
    .toBeVisible();
  expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
});

it("responds to device language changes and cross-tab persisted preferences", async () => {
  using _language = restoreLanguage();
  const languages = vi.spyOn(navigator, "languages", "get").mockReturnValue(["ja-JP"]);
  setLanguagePreference("system");
  await using screen = await render(<LanguageWorkspace />);
  await expect
    .element(screen.getByRole("treeitem", { name: "General", exact: true }))
    .toBeVisible();
  await act(() => {
    languages.mockReturnValue(["zh-TW"]);
    window.dispatchEvent(new Event("languagechange"));
  });
  await expect.element(screen.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
  await act(() => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "en");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: LANGUAGE_STORAGE_KEY,
        newValue: "en",
        storageArea: localStorage,
      }),
    );
  });
  await expect
    .element(screen.getByRole("treeitem", { name: "General", exact: true }))
    .toBeVisible();
  expect(document.documentElement.lang).toBe("en");
});

it("keeps live switching usable when browser storage is blocked", async () => {
  using _language = restoreLanguage();
  setLanguagePreference("en");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Storage blocked", "SecurityError");
  });
  await using screen = await render(<LanguageWorkspace />);
  await screen.getByRole("combobox", { name: "Interface language" }).selectOptions("zh");
  await expect.element(screen.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
  expect(getLanguage()).toBe("zh");
  expect(document.documentElement.lang).toBe("zh");
});

it("searches translated setting labels", async () => {
  using _language = restoreLanguage();
  await page.viewport(1280, 900);
  setLanguagePreference("zh");
  await using screen = await render(<LanguageWorkspace />);
  await screen.getByRole("combobox", { name: "搜索设置" }).fill("界面字体");
  await expect.element(screen.getByRole("option", { name: "界面字体 外观" })).toBeVisible();
});

it("renders the actual local agent setup and project import in Chinese", async () => {
  using _language = restoreLanguage();
  setLanguagePreference("zh");
  await using screen = await render(
    <AppAtomRegistryProvider>
      <WelcomeWizard localAvailable={false} onDone={() => undefined} />
    </AppAtomRegistryProvider>,
  );
  await expect.element(page.getByText("连接你的 Agent", { exact: true })).toBeVisible();
  await expect
    .element(page.getByText("选择一个 Agent 开始编程。你可以稍后添加更多。", { exact: true }))
    .toBeVisible();
  await page.getByRole("button", { name: "继续", exact: true }).click();
  await expect.element(page.getByText("导入你的项目", { exact: true })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "不导入项目", exact: true })).toBeVisible();
  expect(screen.container.isConnected).toBe(true);
});
