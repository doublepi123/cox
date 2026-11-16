import type { UnifiedSettings } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import {
  fixture,
  panel,
  requestUrl,
} from "../components/settings/notificationsSettingsTestFixture";
import { notificationDeepLinkTests } from "../components/settings/notificationDeepLinkTests";
import { notificationDeviceTests } from "../components/settings/notificationDeviceTests";
import type {
  BrowserPushSubscription,
  WebPushSupportState,
} from "../pwa/serviceWorkerRegistration";
import "../index.css";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  support: { supported: true } as WebPushSupportState,
  save: vi.fn(),
  listeners: new Set<() => void>(),
  browserSubscription: null as BrowserPushSubscription | null,
  unsubscribe: vi.fn(),
}));

vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => {
    const value = useSyncExternalStore(
      (listener) => {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
      () => state.settings,
    );
    return value;
  }) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "https://cox.test",
}));
vi.mock(import("../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, updateSettings: state.save as never },
  };
});
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("../pwa/serviceWorkerRegistration"), async (original) => ({
  ...(await original()),
  getWebPushSupportState: () => state.support,
  getCurrentBrowserPushSubscription: async () => state.browserSubscription,
  unsubscribeBrowserFromWebPush: () => state.unsubscribe(),
}));

describe("notifications settings", () => {
  it("adds a Bark channel and sends a real test request at 390px", async () => {
    using _fixture = fixture(state);
    await page.viewport(390, 844);
    await using screen = await render(panel());
    await expect
      .element(
        screen.getByRole("textbox", { name: "Server URL for notification links", exact: true }),
      )
      .toHaveValue(window.location.origin);
    await screen.getByRole("button", { name: "Add Webhook", exact: true }).click();
    await screen.getByRole("textbox", { name: "Channel name", exact: true }).fill("Phone Bark");
    await screen
      .getByRole("textbox", { name: "Bark server URL with device key", exact: true })
      .fill("https://api.day.app/device-key/");
    await screen.getByRole("button", { name: "Add channel", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Phone Bark" })).toBeVisible();
    expect(state.settings.notifications.publicBaseUrl).toBe(window.location.origin);
    await screen.getByRole("button", { name: "Send Test", exact: true }).click();

    await expect.element(page.getByText("Test Webhook sent", { exact: true })).toBeVisible();
    const testCall = _fixture.fetchMock.mock.calls.find(
      ([input]) => requestUrl(input).pathname === "/api/notifications/test",
    );
    expect(testCall?.[1]).toMatchObject({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        target: "webhook",
        channelId: state.settings.notifications.webhooks[0]?.id,
      }),
    });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(
      screen
        .getByRole("button", { name: "Send Test", exact: true })
        .element()
        .getBoundingClientRect().height,
    ).toBeGreaterThanOrEqual(44);
  });

  it("validates, normalizes, saves and clears the server origin at desktop width", async () => {
    using _fixture = fixture(state);
    await page.viewport(1280, 900);
    await using screen = await render(panel());
    const input = screen.getByRole("textbox", {
      name: "Server URL for notification links",
      exact: true,
    });
    const save = screen.getByRole("button", { name: "Save server URL", exact: true });
    await input.fill("https://cox.example.com/thread");
    await save.click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(state.settings.notifications.publicBaseUrl).toBeNull();
    await input.fill("https://cox.example.com:443/");
    await save.click();
    await expect
      .poll(() => state.settings.notifications.publicBaseUrl)
      .toBe("https://cox.example.com");
    await input.fill("");
    await save.click();
    await expect.poll(() => state.settings.notifications.publicBaseUrl).toBeNull();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(1280);
  });

  it("shows the configured origin when server settings arrive after mounting", async () => {
    using _fixture = fixture(state);
    await using screen = await render(panel());
    state.settings = {
      ...state.settings,
      notifications: { ...state.settings.notifications, publicBaseUrl: "https://saved.cox.test" },
    };
    for (const listener of state.listeners) listener();
    await expect
      .element(
        screen.getByRole("textbox", { name: "Server URL for notification links", exact: true }),
      )
      .toHaveValue("https://saved.cox.test");
  });

  it("keeps Webhooks usable on insecure HTTP with disabled push and Chinese guidance", async () => {
    using _fixture = fixture(state, {
      language: "zh",
      theme: "dark",
      support: { supported: false, reason: "insecure_context" },
    });
    const consoleError = vi.spyOn(console, "error");
    await page.viewport(390, 844);
    await using screen = await render(panel());
    await expect
      .element(screen.getByRole("switch", { name: "在此设备上启用推送", exact: true }))
      .toBeDisabled();
    await expect.element(screen.getByRole("note")).toBeVisible();
    expect(screen.getByRole("note").element().textContent).toContain("浏览器 Web Push 需要 HTTPS");
    expect(screen.getByRole("note").element().textContent).toContain("纯 HTTP 局域网");
    await screen.getByRole("button", { name: "添加 Webhook", exact: true }).click();
    await screen.getByRole("textbox", { name: "通道名称", exact: true }).fill("局域网 Bark");
    await screen
      .getByRole("textbox", { name: "包含设备密钥的 Bark 服务器地址", exact: true })
      .fill("https://api.day.app/device-key/");
    await screen.getByRole("button", { name: "添加通道", exact: true }).click();
    await screen.getByRole("button", { name: "发送测试", exact: true }).click();
    await expect
      .poll(() =>
        _fixture.fetchMock.mock.calls.some(
          ([input]) => requestUrl(input).pathname === "/api/notifications/test",
        ),
      )
      .toBe(true);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("explains the iOS standalone requirement without enabling the device switch", async () => {
    using _fixture = fixture(state, {
      support: { supported: false, reason: "ios_requires_standalone_pwa" },
    });
    await using screen = await render(panel());
    await expect.element(screen.getByRole("note")).toBeVisible();
    expect(screen.getByRole("note").element().textContent).toContain("Add Cox to your Home Screen");
    await expect
      .element(screen.getByRole("switch", { name: "Enable Push on this device", exact: true }))
      .toBeDisabled();
  });

  it("requires Telegram details and explicit LAN HTTP opt-in", async () => {
    using _fixture = fixture(state);
    await using screen = await render(panel());
    await screen.getByRole("button", { name: "Add Webhook", exact: true }).click();
    await screen.getByRole("combobox", { name: "Provider", exact: true }).click();
    await expect.element(page.getByRole("option", { name: "Bark" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Ntfy" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "Generic JSON" })).toBeVisible();
    await page.getByRole("option", { name: "Telegram", exact: true }).click();
    await screen.getByRole("textbox", { name: "Channel name", exact: true }).fill("Team Telegram");
    await screen
      .getByRole("textbox", { name: "Telegram Bot API sendMessage URL", exact: true })
      .fill("http://192.168.1.20:8080/sendMessage");
    await screen.getByRole("textbox", { name: "Telegram chat ID", exact: true }).fill("-100123");
    await screen.getByRole("button", { name: "Add channel", exact: true }).click();
    await expect.element(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByRole("alert").element().textContent).toContain("private network option");
    expect(state.settings.notifications.webhooks).toHaveLength(0);
    await screen.getByRole("checkbox", { name: "Allow private network HTTP" }).click();
    await screen.getByRole("button", { name: "Add channel", exact: true }).click();
    await expect.element(screen.getByRole("heading", { name: "Team Telegram" })).toBeVisible();
    expect(state.settings.notifications.webhooks[0]).toMatchObject({
      provider: "telegram",
      chatId: "-100123",
      allowPrivateNetwork: true,
    });
  });
});

describe("notification devices", () => notificationDeviceTests(state));
describe("notification deep links", notificationDeepLinkTests);
