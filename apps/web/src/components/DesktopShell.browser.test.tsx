import type { DesktopShellBridge } from "@t3tools/contracts";
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
});
