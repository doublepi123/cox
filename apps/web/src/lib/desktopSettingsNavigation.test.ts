import { createMemoryHistory } from "@tanstack/react-router";
import type { DesktopShellBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { startDesktopSettingsNavigation } from "./desktopSettingsNavigation";

beforeEach(() => vi.stubGlobal("document", {}));
afterEach(() => vi.unstubAllGlobals());

function bridge(kind: "main" | "settings" | "usage"): DesktopShellBridge {
  return {
    platform: "darwin",
    windowKind: kind,
    ready: vi.fn(),
    onQuitRequested: () => () => {},
    answerQuit: vi.fn(),
    setWindowColors: vi.fn(),
    onWindowState: () => () => {},
    syncWindowControls: vi.fn(),
    openSettings: vi.fn(async () => {}),
    openUsage: vi.fn(async () => {}),
    openMain: vi.fn(async () => {}),
  };
}

describe("desktop settings navigation", () => {
  it("opens usage without navigating the main thread or existing settings", async () => {
    for (const kind of ["main", "settings"] as const) {
      const initial = kind === "main" ? "/threads/current" : "/settings/general";
      const history = createMemoryHistory({ initialEntries: [initial] });
      const shell = bridge(kind);
      const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
      history.push("/usage?metric=tokens#models");
      await vi.waitFor(() =>
        expect(shell.openUsage).toHaveBeenCalledWith("/usage?metric=tokens#models"),
      );
      expect(history.location.pathname).toBe(initial);
      stop?.();
    }
  });

  it("keeps usage filters inline and opens settings or thread links in their own windows", async () => {
    const history = createMemoryHistory({ initialEntries: ["/usage"] });
    const shell = bridge("usage");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/usage?metric=tokens");
    await vi.waitFor(() => expect(history.location.search).toBe("?metric=tokens"));
    history.push("/settings/providers?instanceId=remote");
    await vi.waitFor(() =>
      expect(shell.openSettings).toHaveBeenCalledWith("/settings/providers?instanceId=remote"),
    );
    history.push("/threads/selected");
    await vi.waitFor(() => expect(shell.openMain).toHaveBeenCalledWith("/threads/selected"));
    expect(history.location.pathname).toBe("/usage");
    expect(shell.openUsage).not.toHaveBeenCalled();
    stop?.();
  });

  it("keeps old desktop bridges without usage support working inline", async () => {
    const history = createMemoryHistory({ initialEntries: ["/threads/current"] });
    const { openUsage: _openUsage, ...shell } = bridge("main");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/usage");
    await vi.waitFor(() => expect(history.location.pathname).toBe("/usage"));
    stop?.();
  });

  it("preserves usage navigation through the main owner on old settings bridges", async () => {
    const history = createMemoryHistory({ initialEntries: ["/settings/general"] });
    const { openUsage: _openUsage, ...shell } = bridge("settings");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/usage");
    await vi.waitFor(() => expect(shell.openMain).toHaveBeenCalledWith("/usage"));
    expect(history.location.pathname).toBe("/settings/general");
    stop?.();
  });

  it("opens usage even when a bridge does not provide settings windows", async () => {
    const history = createMemoryHistory({ initialEntries: ["/threads/current"] });
    const { openSettings: _openSettings, ...shell } = bridge("main");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/usage");
    await vi.waitFor(() => expect(shell.openUsage).toHaveBeenCalledWith("/usage"));
    expect(history.location.pathname).toBe("/threads/current");
    stop?.();
  });

  it("leaves the session mounted and reports a failed usage window request", async () => {
    const history = createMemoryHistory({ initialEntries: ["/threads/current"] });
    const shell = bridge("main");
    const error = new Error("Usage window unavailable");
    shell.openUsage = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const stop = startDesktopSettingsNavigation(history, shell, onError);
    history.push("/usage?metric=tokens");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(history.location.pathname).toBe("/threads/current");
    stop?.();
  });
  it("opens contextual settings without changing the main window location", async () => {
    const history = createMemoryHistory({ initialEntries: ["/threads/current"] });
    const shell = bridge("main");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/settings/providers?machine=local#models");
    await vi.waitFor(() =>
      expect(shell.openSettings).toHaveBeenCalledWith("/settings/providers?machine=local#models"),
    );
    expect(history.location.pathname).toBe("/threads/current");
    stop?.();
    history.push("/settings/about");
    expect(history.location.pathname).toBe("/settings/about");
  });

  it("allows settings navigation inside the settings window and sends thread links to the main window", async () => {
    const history = createMemoryHistory({ initialEntries: ["/settings/general"] });
    const shell = bridge("settings");
    const stop = startDesktopSettingsNavigation(history, shell, vi.fn());
    history.push("/settings/appearance");
    await vi.waitFor(() => expect(history.location.pathname).toBe("/settings/appearance"));
    history.push("/threads/selected");
    await vi.waitFor(() => expect(shell.openMain).toHaveBeenCalledWith("/threads/selected"));
    expect(history.location.pathname).toBe("/settings/appearance");
    expect(shell.openSettings).not.toHaveBeenCalled();
    stop?.();
  });

  it("keeps settings and thread navigation inline when a remote window has no split-window role", async () => {
    const history = createMemoryHistory({ initialEntries: ["/threads/current"] });
    const { windowKind: _windowKind, ...shell } = bridge("main");
    expect(startDesktopSettingsNavigation(history, shell, vi.fn())).toBeUndefined();
    history.push("/settings/providers?machine=remote");
    await vi.waitFor(() => expect(history.location.pathname).toBe("/settings/providers"));
    history.push("/threads/selected");
    await vi.waitFor(() => expect(history.location.pathname).toBe("/threads/selected"));
    expect(shell.openSettings).not.toHaveBeenCalled();
    expect(shell.openMain).not.toHaveBeenCalled();
  });

  it("preserves browser navigation and reports a failed desktop window request", async () => {
    const history = createMemoryHistory({ initialEntries: ["/"] });
    expect(startDesktopSettingsNavigation(history, undefined, vi.fn())).toBeUndefined();
    history.push("/settings/general");
    expect(history.location.pathname).toBe("/settings/general");
    const shell = bridge("main");
    const error = new Error("Window unavailable");
    shell.openSettings = vi.fn(async () => {
      throw error;
    });
    const onError = vi.fn();
    const stop = startDesktopSettingsNavigation(history, shell, onError);
    history.push("/settings/about");
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(history.location.pathname).toBe("/settings/general");
    stop?.();
  });
});
