import type { DesktopShellBridge, DesktopWindowState } from "@t3tools/contracts";
import "../index.css";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import { DesktopShell } from "./DesktopShell";

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
});
