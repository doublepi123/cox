import type {
  DesktopShellBridge,
  DesktopWindowState,
  DesktopBackendUpdateState,
} from "@t3tools/contracts";
import "../index.css";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { DesktopShell } from "./DesktopShell";
import { DesktopUpdates } from "./settings/DesktopUpdates";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { setLanguagePreference } from "../i18n";

function installBridge(bridge: DesktopShellBridge | undefined) {
  const previous = Object.getOwnPropertyDescriptor(window, "coxDesktop");
  Object.defineProperty(window, "coxDesktop", { configurable: true, value: bridge });
  return {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "coxDesktop", previous);
      else Reflect.deleteProperty(window, "coxDesktop");
    },
  };
}

describe("desktop shell", () => {
  it.each(["en", "zh"] as const)(
    "offers immediate and deferred application of a ready backend update in %s",
    async (language) => {
      setLanguagePreference(language);
      using _language = { [Symbol.dispose]: () => setLanguagePreference("en") };
      const ready: DesktopBackendUpdateState = {
        desktopVersion: "0.2.13",
        bundledVersion: "0.1.50",
        currentVersion: "0.1.50",
        latestVersion: "0.1.52",
        status: "ready",
        message: null,
      };
      let publish: ((state: DesktopBackendUpdateState) => void) | undefined;
      const bridge: DesktopShellBridge = {
        platform: "darwin",
        ready: vi.fn(),
        onQuitRequested: vi.fn(() => () => {}),
        answerQuit: vi.fn(),
        setWindowColors: vi.fn(),
        onWindowState: vi.fn(() => () => {}),
        syncWindowControls: vi.fn(),
        getBackendUpdate: vi.fn(async () => ready),
        applyBackendUpdate: vi.fn(async () => {}),
        onBackendUpdate: (listener) => {
          publish = listener;
          return () => {};
        },
      };
      using _bridge = installBridge(bridge);
      await using _screen = await render(<DesktopShell />);
      const now = language === "zh" ? "立即更新" : "Update now";
      const later = language === "zh" ? "稍后" : "Later";
      await expect.element(page.getByRole("button", { name: now, exact: true })).toBeVisible();
      expect(page.getByRole("alertdialog").element().textContent).toContain("0.1.52");
      await page.getByRole("button", { name: later, exact: true }).click();
      expect(bridge.applyBackendUpdate).not.toHaveBeenCalled();
      expect(bridge.answerQuit).not.toHaveBeenCalled();
      await act(() => publish?.({ ...ready, latestVersion: "0.1.53" }));
      await page.getByRole("button", { name: now, exact: true }).click();
      await vi.waitFor(() => expect(bridge.applyBackendUpdate).toHaveBeenCalledOnce());
      expect(bridge.answerQuit).not.toHaveBeenCalled();
    },
  );

  it("keeps installing a client update behind the themed quit confirmation", async () => {
    let requestQuit: ((reason?: "quit" | "update") => void) | undefined;
    const bridge: DesktopShellBridge = {
      platform: "win32",
      ready: vi.fn(),
      onQuitRequested: (listener) => {
        requestQuit = listener;
        return () => {};
      },
      answerQuit: vi.fn(),
      setWindowColors: vi.fn(),
      onWindowState: () => () => {},
      syncWindowControls: vi.fn(),
    };
    using _bridge = installBridge(bridge);
    await using _screen = await render(<DesktopShell />);
    await act(() => requestQuit?.("update"));
    await expect
      .element(page.getByRole("heading", { name: "Install client update?" }))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(bridge.answerQuit).toHaveBeenLastCalledWith(false);
    await act(() => requestQuit?.("update"));
    await page.getByRole("button", { name: "Open installer", exact: true }).click();
    expect(bridge.answerQuit).toHaveBeenLastCalledWith(true);
  });
  it("persists ignored Cox versions through the shared update menu and allows recovery", async () => {
    const initial: DesktopBackendUpdateState = {
      desktopVersion: "0.2.3",
      bundledVersion: null,
      currentVersion: "0.1.41",
      latestVersion: "0.1.42",
      status: "available",
      message: null,
      automaticChecks: true,
      ignoredVersion: null,
    };
    let current = initial;
    const bridge: DesktopShellBridge = {
      platform: "win32",
      ready: vi.fn(),
      onQuitRequested: vi.fn(() => () => {}),
      answerQuit: vi.fn(),
      setWindowColors: vi.fn(),
      onWindowState: vi.fn(() => () => {}),
      syncWindowControls: vi.fn(),
      getBackendUpdate: vi.fn(async () => current),
      onBackendUpdate: vi.fn(() => () => {}),
      checkBackendUpdate: vi.fn(async () => current),
      installBackendUpdate: vi.fn(async () => initial),
      setBackendUpdatePolicy: vi.fn(async (next, version) => {
        current = {
          ...initial,
          latestVersion: null,
          status: "idle",
          automaticChecks: next !== "never",
          ignoredVersion: next === "ignore-version" ? (version ?? null) : null,
        };
        return current;
      }),
    };
    using _bridge = installBridge(bridge);
    setLanguagePreference("zh");
    try {
      await using _screen = await render(<DesktopUpdates />);
      await expect
        .element(page.getByRole("button", { name: "下载 Cox 更新", exact: true }))
        .toBeVisible();
      await act(() => setLanguagePreference("en"));
      await page.getByRole("button", { name: "Update actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Ignore this Cox version", exact: true }).click();
      expect(bridge.setBackendUpdatePolicy).toHaveBeenLastCalledWith("ignore-version", "0.1.42");
      expect(bridge.installBackendUpdate).not.toHaveBeenCalled();
      expect(bridge.answerQuit).not.toHaveBeenCalled();
      await act(() => setLanguagePreference("zh"));
      await expect
        .element(page.getByText("已忽略 Cox 0.1.42，仍会提醒更新的版本。", { exact: true }))
        .toBeVisible();
      await page.getByRole("button", { name: "检查更新", exact: true }).click();
      expect(bridge.checkBackendUpdate).toHaveBeenCalledOnce();
      await page.getByRole("button", { name: "更新操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "恢复自动检查更新", exact: true }).click();
      expect(bridge.setBackendUpdatePolicy).toHaveBeenLastCalledWith("automatic", undefined);
    } finally {
      setLanguagePreference("en");
    }
  });

  it("shows independent versions and stages updates without quitting or restarting tasks", async () => {
    const initial: DesktopBackendUpdateState = {
      desktopVersion: "0.2.0",
      bundledVersion: null,
      currentVersion: "0.1.41",
      latestVersion: null,
      status: "idle",
      message: null,
    };
    let update: ((state: DesktopBackendUpdateState) => void) | undefined;
    const available = { ...initial, latestVersion: "0.1.42", status: "available" as const };
    const ready = { ...available, status: "ready" as const };
    const bridge: DesktopShellBridge = {
      platform: "win32",
      ready: vi.fn(),
      onQuitRequested: vi.fn(() => () => {}),
      answerQuit: vi.fn(),
      setWindowColors: vi.fn(),
      onWindowState: vi.fn(() => () => {}),
      syncWindowControls: vi.fn(),
      getBackendUpdate: vi.fn(async () => initial),
      checkBackendUpdate: vi.fn(async () => available),
      installBackendUpdate: vi.fn(async () => ready),
      onBackendUpdate: (listener) => {
        update = listener;
        return () => {};
      },
    };
    using _bridge = installBridge(bridge);
    await using screen = await render(
      <DesktopShell>
        <span>Running tasks</span>
      </DesktopShell>,
    );
    await act(() => update?.(available));
    await expect.element(page.getByText("Cox 0.1.42 is available.")).toBeVisible();
    expect(page.getByRole("alertdialog").element().querySelectorAll("button")).toHaveLength(2);
    await expect
      .element(page.getByRole("button", { name: "Ignore this version", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Ignore all updates", exact: true }))
      .not.toBeInTheDocument();
    expect(bridge.installBackendUpdate).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Download Cox update", exact: true }).click();
    await expect
      .element(
        page.getByText(
          "Cox is downloaded. It will activate on the next launch without interrupting current tasks.",
        ),
      )
      .toBeVisible();
    expect(bridge.answerQuit).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await screen.rerender(<DesktopUpdates />);
    await expect.element(page.getByText("0.2.0", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0.1.41", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Not bundled", { exact: true })).toBeVisible();
  });

  it("does not add desktop chrome to the browser", async () => {
    using _bridge = installBridge(undefined);
    await using _screen = await render(<DesktopShell />);
    expect(document.documentElement.dataset.coxDesktop).toBeUndefined();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("answers ordinary quit requests directly without showing a confirmation", async () => {
    let requestQuit: ((reason?: "quit" | "update") => void) | undefined;
    const unsubscribe = vi.fn();
    const bridge: DesktopShellBridge = {
      platform: "win32",
      ready: vi.fn(),
      onQuitRequested: (listener) => {
        requestQuit = listener;
        return unsubscribe;
      },
      answerQuit: vi.fn(),
      setWindowColors: vi.fn(),
      onWindowState: vi.fn(() => () => {}),
      syncWindowControls: vi.fn(),
    };
    using _bridge = installBridge(bridge);
    await using screen = await render(<DesktopShell />);
    expect(bridge.ready).toHaveBeenCalledOnce();
    expect(bridge.setWindowColors).toHaveBeenCalledWith(
      expect.stringMatching(/^#[a-f0-9]{6}$/),
      expect.stringMatching(/^#[a-f0-9]{6}$/),
    );
    expect(document.documentElement.dataset.coxDesktop).toBe("windows");
    await act(() => requestQuit?.("quit"));
    expect(bridge.answerQuit).toHaveBeenLastCalledWith(true);
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    await screen.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(document.documentElement.dataset.coxDesktop).toBeUndefined();
  });

  it("integrates macOS controls and clears their layout on fullscreen and unmount", async () => {
    let updateState: ((state: DesktopWindowState) => void) | undefined;
    const stopWindowState = vi.fn();
    const bridge: DesktopShellBridge = {
      platform: "darwin",
      ready: vi.fn(),
      onQuitRequested: vi.fn(() => () => {}),
      answerQuit: vi.fn(),
      setWindowColors: vi.fn(),
      onWindowState: (listener) => {
        updateState = listener;
        return stopWindowState;
      },
      syncWindowControls: vi.fn(),
    };
    using _bridge = installBridge(bridge);
    await using screen = await render(<DesktopShell />);
    const root = document.documentElement;
    expect(root.dataset.coxDesktop).toBe("macos");
    expect(root.classList.contains("wco")).toBe(true);
    expect(getComputedStyle(root).getPropertyValue("--workspace-controls-left").trim()).toContain(
      "92px",
    );
    await act(() => updateState?.({ fullscreen: false, zoomFactor: 1.25 }));
    expect(root.style.getPropertyValue("--desktop-window-zoom")).toBe("1.25");
    await act(() => updateState?.({ fullscreen: true, zoomFactor: 1.25 }));
    expect(root.classList.contains("wco")).toBe(false);
    expect(getComputedStyle(root).getPropertyValue("--workspace-controls-left").trim()).toBe(
      "0.75rem",
    );
    await act(() => updateState?.({ fullscreen: false, zoomFactor: 1 }));
    expect(root.classList.contains("wco")).toBe(true);
    await screen.unmount();
    expect(stopWindowState).toHaveBeenCalledOnce();
    expect(root.classList.contains("wco")).toBe(false);
    expect(root.dataset.coxDesktop).toBeUndefined();
    expect(root.dataset.desktopFullscreen).toBeUndefined();
    expect(root.style.getPropertyValue("--desktop-window-zoom")).toBe("");
  });

  it.each([false, true])(
    "keeps update confirmation clickable when another dialog opens late: %s",
    async (late) => {
      let requestQuit: ((reason?: "quit" | "update") => void) | undefined;
      const bridge: DesktopShellBridge = {
        platform: "win32",
        ready: vi.fn(),
        onQuitRequested: (listener) => {
          requestQuit = listener;
          return () => {};
        },
        answerQuit: vi.fn(),
        setWindowColors: vi.fn(),
        onWindowState: vi.fn(() => () => {}),
        syncWindowControls: vi.fn(),
      };
      using _bridge = installBridge(bridge);
      const content = (showDialog: boolean) => (
        <DesktopShell>
          {showDialog && (
            <Dialog open>
              <DialogPopup variant="media">
                <DialogTitle>Setup dialog</DialogTitle>
                <button type="button">Setup action</button>
              </DialogPopup>
            </Dialog>
          )}
        </DesktopShell>
      );
      await using screen = await render(content(!late));
      await act(() => requestQuit?.("update"));
      if (late) await screen.rerender(content(true));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(bridge.answerQuit).toHaveBeenLastCalledWith(false);
      await expect.element(page.getByRole("button", { name: "Setup action" })).toBeVisible();
      await act(() => requestQuit?.("update"));
      await page.getByRole("button", { name: "Open installer", exact: true }).click();
      expect(bridge.answerQuit).toHaveBeenLastCalledWith(true);
    },
  );
});
