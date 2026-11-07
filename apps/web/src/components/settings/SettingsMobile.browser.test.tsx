import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useLocation } from "@tanstack/react-router";

import "~/index.css";
import { render, stubGlobal } from "../../../test/render";
import { LANGUAGE_STORAGE_KEY, setLanguagePreference } from "../../i18n";
import { parseLanguagePreference } from "../../i18n/language";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { SidebarProvider } from "../ui/sidebar";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipTrigger } from "../ui/tooltip";
import { SettingsBreadcrumb } from "./SettingsBreadcrumb";
import { SettingsSidebarNav } from "./SettingsSidebarNav";
import { SettingsScopeProvider } from "./SettingsScopeContext";
import { GeneralSettingsPanel } from "./SettingsPanels";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsFrame } from "../../routes/_chat.settings";

function MobileSettingsIndex() {
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <div className="fixed inset-0 flex min-w-0 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-4 pe-2">
              <SettingsBreadcrumb pathname="/settings" showSection={false} />
            </header>
            <SettingsSidebarNav pathname="/settings" layout="menu" />
          </div>
        </SettingsScopeProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

function MobileSettingsSection() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <div className="fixed inset-0 flex min-w-0 flex-col">
            <header className="flex h-12 shrink-0 items-center gap-2 border-b ps-2 pe-2">
              <Button type="button" size="icon-xl" variant="ghost" aria-label="Back">
                Back
              </Button>
              <div className="min-w-0 flex-1 truncate text-sm font-medium">
                {pathname === "/settings/general" ? "常规" : pathname}
              </div>
            </header>
            <GeneralSettingsPanel />
          </div>
        </SettingsScopeProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

async function setupMobileSettings(width: number, height: number, language: "en" | "zh") {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  await page.viewport(width, height);
  setLanguagePreference(language);
  return {
    async [Symbol.asyncDispose]() {
      setLanguagePreference(parseLanguagePreference(originalLanguage));
      if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      await page.viewport(originalWidth, originalHeight);
    },
  };
}

describe("mobile settings", () => {
  it("shows sections as a first-level menu and opens a section from it", async () => {
    await using _settings = await setupMobileSettings(320, 740, "zh");
    await using screen = await render(<MobileSettingsIndex />, { router: "/settings" });
    const breadcrumb = screen.getByRole("navigation", { name: "设置面包屑" });
    await expect.element(breadcrumb).toHaveTextContent("设置");
    const sections = screen.getByRole("tree", { name: "设置分类" });
    await expect.element(sections).toBeVisible();
    await expect.element(screen.getByRole("treeitem", { name: "常规", exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("treeitem", { name: "模型服务中心", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByRole("combobox", { name: "搜索设置" })).toBeVisible();
    expect(screen.container.querySelector('[role="combobox"][aria-label="设置分类"]')).toBeNull();
    await screen.getByRole("treeitem", { name: "外观", exact: true }).click();
    await expect.poll(() => screen.router?.state.location.pathname).toBe("/settings/appearance");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  });

  it("keeps section pages free of the section picker", async () => {
    await using _settings = await setupMobileSettings(320, 740, "zh");
    await using screen = await render(<MobileSettingsSection />, { router: "/settings/general" });
    await expect.element(screen.getByRole("button", { name: "Back" })).toBeVisible();
    expect(screen.container.querySelector('[role="tree"]')).toBeNull();
    expect(screen.container.querySelector('[role="combobox"][aria-label="设置分类"]')).toBeNull();
  });

  it("searches from the first-level menu and navigates to a result", async () => {
    await using _settings = await setupMobileSettings(375, 812, "en");
    await using screen = await render(<MobileSettingsIndex />, { router: "/settings" });
    const searchInput = screen.getByRole("combobox", { name: "Search settings" }).element();
    expect(searchInput.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(getComputedStyle(searchInput).fontSize)).toBeGreaterThanOrEqual(16);
    await screen.getByRole("combobox", { name: "Search settings" }).fill("Interface font");
    await expect
      .element(screen.getByRole("option", { name: "Interface font Appearance" }))
      .toBeVisible();
    await screen.getByRole("option", { name: "Interface font Appearance" }).click();
    await expect.poll(() => screen.router?.state.location.pathname).toBe("/settings/appearance");
    await expect.poll(() => screen.router?.state.location.hash).toBe("interface-font");
  });

  it("fits narrow screens, keeps switches beside their labels, and preserves desktop columns", async () => {
    await using _settings = await setupMobileSettings(320, 812, "en");
    await using screen = await render(<MobileSettingsSection />, { router: "/settings/general" });
    for (const width of [320, 375, 430, 768, 1280]) {
      await page.viewport(width, 812);
      const scroll = screen.container.querySelector<HTMLElement>("[data-settings-page-scroll]")!;
      expect(scroll.scrollWidth, `settings overflow at ${width}px`).toBeLessThanOrEqual(
        scroll.clientWidth,
      );
      const language = screen.getByRole("combobox", { name: "Interface language" }).element();
      const languageTitle = screen.getByRole("heading", { name: "Interface language" }).element();
      const toggle = screen.getByRole("switch", { name: "In-app notifications" }).element();
      const toggleTitle = screen.getByRole("heading", { name: "In-app notifications" }).element();
      if (width < 640) {
        expect(
          Math.abs(toggle.getBoundingClientRect().top - toggleTitle.getBoundingClientRect().top),
        ).toBeLessThan(5);
        expect(language.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
        expect(language.getBoundingClientRect().top).toBeGreaterThan(
          languageTitle.getBoundingClientRect().bottom,
        );
      } else {
        expect(toggle.getBoundingClientRect().left).toBeGreaterThan(
          toggleTitle.getBoundingClientRect().right,
        );
        expect(language.getBoundingClientRect().left).toBeGreaterThan(
          languageTitle.getBoundingClientRect().right,
        );
      }
    }
  });

  it("expands text fields and section actions on narrow screens only", async () => {
    await using _settings = await setupMobileSettings(320, 740, "en");
    await using screen = await render(
      <SettingsSection
        title="Runtime"
        headerAction={
          <Tooltip>
            <TooltipTrigger render={<Button size="xs">Update</Button>} />
          </Tooltip>
        }
      >
        <SettingsRow title="API URL" control={<Input size="sm" aria-label="API URL" />} />
      </SettingsSection>,
    );
    const input = screen.getByRole("textbox", { name: "API URL" });
    const update = screen.getByRole("button", { name: "Update" });
    expect(input.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(update.element().getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await page.viewport(1280, 800);
    expect(input.element().getBoundingClientRect().height).toBeLessThan(44);
    expect(update.element().getBoundingClientRect().height).toBeLessThan(44);
  });
});

describe("desktop settings window", () => {
  it("fills the available width instead of shrinking beside the window backdrop", async () => {
    await using _settings = await setupMobileSettings(1440, 900, "zh");
    using _bridge = stubGlobal("coxDesktop", { windowKind: "settings" });
    await using screen = await render(
      <SidebarProvider>
        <SettingsFrame>
          <div className="flex min-h-0 flex-1">
            <nav className="w-60 shrink-0">设置</nav>
            <section data-settings-content className="min-w-0 flex-1">
              常规
            </section>
          </div>
        </SettingsFrame>
      </SidebarProvider>,
    );
    const frame = screen.container.querySelector("main")!.getBoundingClientRect();
    const content = screen.container
      .querySelector("[data-settings-content]")!
      .getBoundingClientRect();
    expect(frame.width).toBe(1440);
    expect(content.right).toBe(1440);
  });
});
