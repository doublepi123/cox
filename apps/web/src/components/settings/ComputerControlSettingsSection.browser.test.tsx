import type { DesktopComputerPermission, DesktopComputerUseState } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { act, render, stubGlobal } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { ComputerControlSettingsSection } from "./ComputerControlSettingsSection";

function englishLanguage() {
  setLanguagePreference("en");
  return { [Symbol.dispose]: () => setLanguagePreference("system") };
}

function computerState(overrides: Partial<DesktopComputerUseState> = {}): DesktopComputerUseState {
  return {
    supported: true,
    enabled: false,
    engine: "ready",
    engineMessage: null,
    permissions: {
      screenRecording: "denied",
      accessibility: "denied",
      input: "denied",
    },
    appName: "Cox",
    appPath: "/Applications/Cox.app",
    macosVersion: "15.3",
    restartRequired: false,
    stopped: false,
    ready: false,
    ...overrides,
  };
}

function computerBridge(initial: DesktopComputerUseState, platform: "darwin" | "win32" = "darwin") {
  let current = initial;
  const listeners = new Set<(state: DesktopComputerUseState) => void>();
  const publish = (next: DesktopComputerUseState) => {
    current = next;
    for (const listener of listeners) listener(current);
  };
  const bridge = {
    platform,
    getComputerUse: vi.fn(async () => current),
    setComputerUseEnabled: vi.fn(async (enabled: boolean) => {
      current = { ...current, enabled };
      return current;
    }),
    recheckComputerUse: vi.fn(async () => current),
    openComputerUseSettings: vi.fn(async (_permission: DesktopComputerPermission) => undefined),
    restartForComputerUse: vi.fn(async () => undefined),
    resumeComputerUse: vi.fn(async () => {
      current = { ...current, stopped: false, ready: true };
      return current;
    }),
    onComputerUse: vi.fn((listener: (state: DesktopComputerUseState) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }),
  };
  return { bridge, publish };
}

describe("computer control settings", () => {
  it("enables computer control and opens each permission pane from the guide", async () => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(computerState());
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await screen.getByRole("switch", { name: "Computer control" }).click();
    expect(bridge.setComputerUseEnabled).toHaveBeenCalledWith(true);
    await expect
      .element(page.getByRole("dialog", { name: "Set up computer control" }))
      .toBeVisible();
    for (const permission of ["Screen Recording", "Accessibility", "Input Monitoring"] as const) {
      await expect.element(page.getByText(permission, { exact: true })).toBeVisible();
      await page
        .getByRole("button", { name: `Open System Settings for ${permission}`, exact: true })
        .click();
    }
    expect(bridge.openComputerUseSettings.mock.calls.map(([permission]) => permission)).toEqual([
      "screenRecording",
      "accessibility",
      "input",
    ]);
    await expect
      .element(
        page.getByText(
          "On macOS 15+, open Privacy & Security → Input Monitoring. Input control uses the Accessibility grant; Input Monitoring lets Control+Option+Command+Escape stop input from any app.",
          { exact: true },
        ),
      )
      .toBeVisible();
  });

  it("shows Windows capabilities and keeps their names after setting up later", async () => {
    using _language = englishLanguage();
    const appPath = "C:\\Program Files\\Cox\\Cox.exe";
    const { bridge } = computerBridge(
      computerState({
        appPath,
        macosVersion: null,
        permissions: { screenRecording: "denied", accessibility: "granted", input: "denied" },
      }),
      "win32",
    );
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await screen.getByRole("switch", { name: "Computer control" }).click();
    await expect
      .element(page.getByRole("dialog", { name: "Set up computer control" }))
      .toBeVisible();
    for (const capability of ["Screen capture", "UI Automation", "Input and stop shortcut"]) {
      await expect.element(page.getByText(capability, { exact: true })).toBeVisible();
    }
    await expect
      .element(
        page.getByText(
          "Windows needs no extra permissions. Apps running as administrator can't be controlled unless Cox also runs as administrator.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(
        page.getByText(
          "The stop shortcut could not start. Close other apps that capture Ctrl+Alt+Shift+Esc, then Re-check.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByText("No display was found. Re-check after connecting a display."))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: /Open System Settings/ }))
      .not.toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Restart Cox", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText(appPath, { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Set up later", exact: true }).click();
    await expect
      .element(screen.getByText("Enabled, waiting for setup", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Missing: Screen capture, Input and stop shortcut", { exact: true }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Set up computer control", exact: true }))
      .toBeVisible();
  });

  it("keeps missing permission names visible after setting up later", async () => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(
      computerState({
        permissions: { screenRecording: "denied", accessibility: "unknown", input: "denied" },
      }),
    );
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await screen.getByRole("switch", { name: "Computer control" }).click();
    await page.getByRole("button", { name: "Set up later", exact: true }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect
      .element(screen.getByText("Enabled, waiting for permission", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Missing: Screen Recording, Accessibility, Input Monitoring", {
          exact: true,
        }),
      )
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Set up permissions", exact: true }))
      .toBeVisible();
  });

  it("re-checks permissions when the window regains focus", async () => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(computerState({ enabled: true }));
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await expect
      .element(screen.getByRole("button", { name: "Set up permissions", exact: true }))
      .toBeVisible();
    await act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(bridge.recheckComputerUse).toHaveBeenCalledOnce();
  });

  it("shows the ready state when every permission is granted", async () => {
    using _language = englishLanguage();
    const { bridge, publish } = computerBridge(
      computerState({
        enabled: true,
        permissions: { screenRecording: "granted", accessibility: "granted", input: "granted" },
        ready: true,
      }),
    );
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await expect
      .element(screen.getByText("Ready to use computer control", { exact: true }))
      .toBeVisible();
    expect(bridge.onComputerUse).toHaveBeenCalledOnce();
    await act(() =>
      publish(
        computerState({
          enabled: true,
          permissions: { screenRecording: "granted", accessibility: "granted", input: "granted" },
          ready: true,
          stopped: true,
        }),
      ),
    );
    await expect
      .element(screen.getByText("Computer control was stopped", { exact: true }))
      .toBeVisible();
  });

  it("offers restart when macOS requires it", async () => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(computerState({ enabled: true, restartRequired: true }));
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await screen.getByRole("button", { name: "Set up permissions", exact: true }).click();
    await expect
      .element(
        page.getByText("macOS requires quitting and reopening Cox for the grant to take effect.", {
          exact: true,
        }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: "Restart Cox", exact: true }).click();
    expect(bridge.restartForComputerUse).toHaveBeenCalledOnce();
  });

  it("resumes a stopped computer only after an explicit click", async () => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(
      computerState({
        enabled: true,
        stopped: true,
        permissions: { screenRecording: "granted", accessibility: "granted", input: "granted" },
      }),
    );
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await expect
      .element(screen.getByText("Computer control was stopped", { exact: true }))
      .toBeVisible();
    expect(bridge.resumeComputerUse).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Resume", exact: true }).click();
    expect(bridge.resumeComputerUse).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByText("Ready to use computer control", { exact: true }))
      .toBeVisible();
  });

  it.each([
    ["missing", "Computer control engine is missing."],
    ["downloading", "Downloading the computer control engine…"],
    ["error", "Computer control engine error"],
  ] as const)("shows the %s engine state and its message", async (engine, label) => {
    using _language = englishLanguage();
    const { bridge } = computerBridge(
      computerState({ enabled: true, engine, engineMessage: "Engine detail" }),
    );
    using _bridge = stubGlobal("coxDesktop", bridge);
    await using screen = await render(<ComputerControlSettingsSection />);
    await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Engine detail", { exact: true })).toBeVisible();
    expect(screen.container.textContent).not.toContain("Enabled, waiting for permission");
    await screen.getByRole("button", { name: "Set up permissions", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect.element(dialog.getByText("Engine detail", { exact: true })).toBeVisible();
  });

  it("renders nothing without the computer-use bridge", async () => {
    using _language = englishLanguage();
    using _bridge = stubGlobal("coxDesktop", { platform: "darwin" });
    await using screen = await render(<ComputerControlSettingsSection />);
    expect(screen.container.textContent).toBe("");
  });
});
