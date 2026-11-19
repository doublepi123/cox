import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { SettingsContentLayout } from "../routes/_chat.settings";
import { UsageFrame, UsageWindowClose } from "./usage/UsageFrame";
import { SettingsScopeProvider } from "./settings/SettingsScopeContext";
import { SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";
import { WorkspaceTitlebarControls } from "./chat/PanelLayoutControls";
import { Dialog, DialogPopup } from "./ui/dialog";
import { Sheet, SheetPopup } from "./ui/sheet";
import { SidebarProvider } from "./ui/sidebar";
import { Button } from "./ui/button";

const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;

const ROUTES = [
  "/",
  "/new",
  "/usage",
  "/settings",
  "/settings/open-source-licenses",
  ...Object.keys(SETTINGS_SECTION_LABELS),
  "dialog",
  "sheet",
  "right-panel",
  "thread",
] as const;

function ThreadComposer() {
  return (
    <div data-chat-composer-overlay="" className="pointer-events-none fixed inset-x-0 bottom-0">
      <div className="pointer-events-auto flex gap-2 px-3">
        <button type="button">Kimi K3.1 Pro</button>
        <button type="button">排队</button>
      </div>
      <div data-chat-composer-safe-pad="" />
    </div>
  );
}

function RouteChrome({ path }: { path: (typeof ROUTES)[number] }) {
  if (path === "/" || path === "/new") {
    return (
      <>
        <button
          type="button"
          data-sidebar-control
          className="pointer-events-auto fixed top-[var(--workspace-fixed-controls-top)] left-[var(--workspace-controls-left)] z-50 h-11"
        >
          Toggle sidebar
        </button>
        <WorkspaceTitlebarControls
          showMaximizeControl={false}
          rightPanelOpen={false}
          animationsActive={false}
          maximized={false}
          onToggleMaximized={() => undefined}
        >
          <Button type="button">Panels</Button>
        </WorkspaceTitlebarControls>
      </>
    );
  }
  if (path === "/usage") {
    return (
      <UsageFrame>
        <header className="flex h-12 items-center gap-2 px-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">Usage</span>
          <UsageWindowClose />
        </header>
        <Button type="button">Refresh usage</Button>
      </UsageFrame>
    );
  }
  if (path === "dialog") {
    return (
      <Dialog open>
        <DialogPopup>
          <div className="min-h-24 p-4">
            <Button type="button">Save changes</Button>
          </div>
        </DialogPopup>
      </Dialog>
    );
  }
  if (path === "sheet") {
    return (
      <Sheet open>
        <SheetPopup side="right">
          <Button type="button">Sheet action</Button>
        </SheetPopup>
      </Sheet>
    );
  }
  if (path === "right-panel") {
    return (
      <Sheet open>
        <SheetPopup side="right" variant="right-panel" showCloseButton={false}>
          <Button type="button">Files</Button>
        </SheetPopup>
      </Sheet>
    );
  }
  if (path === "thread") return <ThreadComposer />;
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <SettingsScopeProvider search={{}} onChange={() => undefined}>
          <SettingsContentLayout />
        </SettingsScopeProvider>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

function paintedBox(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  let top = rect.top;
  let bottom = rect.bottom;
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (!/(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`)) continue;
    const bounds = node.getBoundingClientRect();
    top = Math.max(top, bounds.top + (Number.parseFloat(style.paddingTop) || 0));
    bottom = Math.min(bottom, bounds.bottom - (Number.parseFloat(style.paddingBottom) || 0));
  }
  return {
    top: Math.max(top, 0),
    bottom: Math.min(bottom, window.innerHeight),
  };
}

function visibleControls(root: ParentNode) {
  return [
    ...root.querySelectorAll<HTMLElement>(
      "button, a, input, textarea, select, [role='button'], [role='switch'], [role='combobox'], [role='treeitem']",
    ),
  ].flatMap((element) => {
    const box = paintedBox(element);
    if (box.bottom - box.top < 1) return [];
    const label =
      element.getAttribute("aria-label") ||
      element.textContent?.trim().slice(0, 80) ||
      element.tagName;
    return [{ element, box, label }];
  });
}

function expectClearOfSafeArea(root: ParentNode, path = "") {
  const controls = visibleControls(root);
  expect(controls.length).toBeGreaterThan(0);
  const shell = root.querySelector<HTMLElement>("[data-app-modal]");
  if (shell) {
    const style = getComputedStyle(shell);
    expect(style.paddingTop, "settings shell padding-top").toBe(`${SAFE_TOP}px`);
    expect(style.paddingBottom, "settings shell padding-bottom").toBe(`${SAFE_BOTTOM}px`);
  }
  const bottomLimit = window.innerHeight - SAFE_BOTTOM;
  for (const { box, label } of controls) {
    expect(box.top, `${path} ${label}`).toBeGreaterThanOrEqual(SAFE_TOP);
    expect(box.bottom, `${path} ${label}`).toBeLessThanOrEqual(bottomLimit + 0.5);
  }
}

describe("safe area on full-screen routes", () => {
  it.each(["light", "dark"] as const)(
    "keeps interactive controls outside the status bar in the %s theme",
    async (theme) => {
      const root = document.documentElement;
      const originallyDark = root.classList.contains("dark");
      root.style.setProperty("--cox-safe-top", `${SAFE_TOP}px`);
      root.style.setProperty("--cox-safe-bottom", `${SAFE_BOTTOM}px`);
      root.classList.toggle("dark", theme === "dark");
      const originalWidth = window.innerWidth;
      const originalHeight = window.innerHeight;
      await page.viewport(390, 844);
      try {
        for (const path of ROUTES) {
          await using _screen = await render(<RouteChrome path={path} />, {
            router: path.startsWith("/") ? path : "/",
          });
          await expect
            .poll(() => visibleControls(document).every((control) => control.box.top >= SAFE_TOP))
            .toBe(true);
          expectClearOfSafeArea(document, path);
          if (path === "thread") {
            const pad = document.querySelector<HTMLElement>("[data-chat-composer-safe-pad]");
            expect(pad?.getBoundingClientRect().height).toBe(SAFE_BOTTOM + 16);
          }
          if (path.startsWith("/settings")) {
            const header = document.querySelector("[data-settings-header]");
            if (!(header instanceof HTMLElement)) throw new Error(`${path} is missing its header`);
            const headerBox = header.getBoundingClientRect();
            expect(headerBox.top, path).toBeGreaterThanOrEqual(SAFE_TOP);
            const scroll = document.querySelector(
              "[data-settings-page-scroll], [data-slot='scroll-area-viewport']",
            );
            if (scroll instanceof HTMLElement) {
              expect(scroll.getBoundingClientRect().top, path).toBeGreaterThanOrEqual(
                headerBox.bottom - 1,
              );
              scroll.scrollTop = 240;
              expect(header.getBoundingClientRect().top, path).toBe(headerBox.top);
            }
          }
        }
      } finally {
        root.style.removeProperty("--cox-safe-top");
        root.style.removeProperty("--cox-safe-bottom");
        root.classList.toggle("dark", originallyDark);
        await page.viewport(originalWidth, originalHeight);
      }
    },
  );

  it("keeps the composer margin without the gesture inset while the keyboard is open", async () => {
    const root = document.documentElement;
    root.style.setProperty("--cox-safe-bottom", `${SAFE_BOTTOM}px`);
    root.setAttribute("data-software-keyboard", "");
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    await page.viewport(390, 844);
    try {
      await using _screen = await render(<ThreadComposer />, { router: "/" });
      const pad = document.querySelector<HTMLElement>("[data-chat-composer-safe-pad]");
      expect(pad?.getBoundingClientRect().height).toBe(16);
      const model = document.querySelector("button");
      expect(model?.getBoundingClientRect().bottom).toBeLessThanOrEqual(844 - 16 + 0.5);
    } finally {
      root.style.removeProperty("--cox-safe-bottom");
      root.removeAttribute("data-software-keyboard");
      await page.viewport(originalWidth, originalHeight);
    }
  });
});
