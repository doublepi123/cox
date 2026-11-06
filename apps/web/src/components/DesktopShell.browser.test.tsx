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
import { DesktopBackendUpdates } from "./settings/DesktopBackendUpdates";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";

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
    await screen.rerender(<DesktopBackendUpdates />);
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

  it("uses the themed quit dialog, focuses cancel and keeps stopping explicit", async () => {
    let requestQuit: (() => void) | undefined;
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
    await act(() => requestQuit?.());
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    await expect.element(cancel).toHaveFocus();
    await cancel.click();
    expect(bridge.answerQuit).toHaveBeenLastCalledWith(false);
    await act(() => requestQuit?.());
    await page.getByRole("button", { name: "Quit Cox", exact: true }).click();
    expect(bridge.answerQuit).toHaveBeenLastCalledWith(true);
    await expect
      .element(page.getByRole("button", { name: "Quitting…", exact: true }))
      .toBeDisabled();
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
    "keeps quit clickable when another dialog opens late: %s",
    async (late) => {
      let requestQuit: (() => void) | undefined;
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
      await act(() => requestQuit?.());
      if (late) await screen.rerender(content(true));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      expect(bridge.answerQuit).toHaveBeenLastCalledWith(false);
      await expect.element(page.getByRole("button", { name: "Setup action" })).toBeVisible();
      await act(() => requestQuit?.());
      await page.getByRole("button", { name: "Quit Cox", exact: true }).click();
      expect(bridge.answerQuit).toHaveBeenLastCalledWith(true);
    },
  );
});
