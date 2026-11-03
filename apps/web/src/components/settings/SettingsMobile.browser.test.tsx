import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { useLocation } from "@tanstack/react-router";

import "~/index.css";
import { render } from "../../../test/render";
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

function MobileSettings() {
  const pathname = useLocation({ select: (location) => location.pathname });
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <div className="fixed inset-0 flex min-w-0 flex-col">
            <SettingsBreadcrumb pathname={pathname} showSection={false} />
            <SettingsSidebarNav pathname={pathname} layout="bar" />
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
  it("reaches distant sections through a visible picker and reflects detail pages", async () => {
    await using _settings = await setupMobileSettings(320, 740, "zh");
    await using screen = await render(<MobileSettings />, { router: "/settings/diagnostics" });
    const breadcrumb = screen.getByRole("navigation", { name: "设置面包屑" });
    await expect.element(breadcrumb).toHaveTextContent("设置");
    expect(breadcrumb.element().textContent).not.toContain("维护");
    const sections = screen.getByRole("combobox", { name: "设置分类" });
    await expect.element(sections).toHaveTextContent("维护");
    await sections.click();
    await page.getByRole("option", { name: "归档", exact: true }).click();
    await expect.poll(() => screen.router?.state.location.pathname).toBe("/settings/archived");
    await expect.element(sections).toHaveTextContent("归档");
    await expect.element(screen.getByRole("button", { name: "搜索设置" })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(320);
  });

  it("closes a populated search in one tap and still navigates from search results", async () => {
    await using _settings = await setupMobileSettings(375, 812, "en");
    await using screen = await render(<MobileSettings />, { router: "/settings/general" });
    await screen.getByRole("button", { name: "Search settings" }).click();
    await expect.element(screen.getByText("Type to search settings")).toBeVisible();
    expect(screen.container.querySelector('[role="tree"]')).toBeNull();
    const searchInput = screen.getByRole("combobox", { name: "Search settings" }).element();
    expect(searchInput.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(getComputedStyle(searchInput).fontSize)).toBeGreaterThanOrEqual(16);
    const searchScroll = screen.container.querySelector<HTMLElement>(
      "[data-slot=scroll-area-viewport]",
    )!;
    searchScroll.scrollTop = searchScroll.scrollHeight;
    await expect
      .poll(() => {
        const close = screen
          .getByRole("button", { name: "Close", exact: true })
          .element()
          .getBoundingClientRect();
        return close.top >= 0 && close.bottom <= window.innerHeight;
      })
      .toBe(true);
    await screen.getByRole("combobox", { name: "Search settings" }).fill("Interface font");
    await expect
      .element(screen.getByRole("option", { name: "Interface font Appearance" }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Close", exact: true }).click();
    await expect.element(screen.getByRole("combobox", { name: "Settings sections" })).toBeVisible();
    await screen.getByRole("button", { name: "Search settings" }).click();
    await expect.element(screen.getByRole("combobox", { name: "Search settings" })).toHaveValue("");
    await screen.getByRole("combobox", { name: "Search settings" }).fill("Interface font");
    await screen.getByRole("option", { name: "Interface font Appearance" }).click();
    await expect.poll(() => screen.router?.state.location.pathname).toBe("/settings/appearance");
    await expect.poll(() => screen.router?.state.location.hash).toBe("interface-font");
    await expect
      .element(screen.getByRole("combobox", { name: "Settings sections" }))
      .toHaveTextContent("Appearance");
  });

  it("fits narrow screens, keeps switches beside their labels, and preserves desktop columns", async () => {
    await using _settings = await setupMobileSettings(320, 812, "en");
    await using screen = await render(<MobileSettings />, { router: "/settings/general" });
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
