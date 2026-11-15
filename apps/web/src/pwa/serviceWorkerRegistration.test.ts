import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  getCurrentBrowserPushSubscription,
  getWebPushSupportState,
  InvalidBase64UrlError,
  registerCoxServiceWorker,
  subscribeBrowserToWebPush,
  unsubscribeBrowserFromWebPush,
  urlBase64ToUint8Array,
  WebPushError,
  type WebPushEnvironment,
} from "./serviceWorkerRegistration";

const supportedEnvironment: WebPushEnvironment = {
  isSecureContext: true,
  userAgent: "Chromium",
  maxTouchPoints: 0,
  standalone: false,
  serviceWorkerAvailable: true,
  pushAvailable: true,
  notificationPermission: "default",
};

afterEach(() => vi.unstubAllGlobals());

describe("base64url public keys", () => {
  it.each(["AAH-_w", "AAH-_w=="])("decodes %s to exact application server key bytes", (key) => {
    expect(urlBase64ToUint8Array(key)).toEqual(new Uint8Array([0, 1, 254, 255]));
  });

  it.each(["", "A", "AA+", "AA/", "AA A", "AA=", "AA===", "AB", "AA==\n"])(
    "rejects malformed or noncanonical key %j with a typed error",
    (key) => {
      expect(() => urlBase64ToUint8Array(key)).toThrow(InvalidBase64UrlError);
    },
  );
});

describe("Web Push support", () => {
  it.each([
    [{ isSecureContext: false }, "insecure_context"],
    [{ userAgent: "iPhone" }, "ios_requires_standalone_pwa"],
    [{ userAgent: "Macintosh", maxTouchPoints: 5 }, "ios_requires_standalone_pwa"],
    [{ serviceWorkerAvailable: false }, "service_worker_unavailable"],
    [{ pushAvailable: false }, "push_unavailable"],
    [{ notificationPermission: "denied" }, "notification_permission_denied"],
  ] satisfies readonly (readonly [Partial<WebPushEnvironment>, string])[])(
    "explains unavailable browser capabilities %j",
    (overrides, reason) => {
      expect(getWebPushSupportState({ ...supportedEnvironment, ...overrides })).toEqual({
        supported: false,
        reason,
      });
    },
  );

  it.each(["iPhone", "Macintosh", "Chromium"])("supports installed browser %s", (userAgent) => {
    expect(
      getWebPushSupportState({
        ...supportedEnvironment,
        userAgent,
        maxTouchPoints: 5,
        standalone: true,
      }),
    ).toEqual({ supported: true });
  });

  it("reports unavailable support without browser globals", () => {
    vi.stubGlobal("window", undefined);
    expect(getWebPushSupportState()).toEqual({ supported: false, reason: "insecure_context" });
  });
});

function installBrowser() {
  const unsubscribe = vi.fn(async () => true);
  const subscription = {
    endpoint: "https://push.example/subscription",
    toJSON: () => ({ keys: { p256dh: "public-key", auth: "auth-secret" } }),
    unsubscribe,
  };
  let subscribed = false;
  const pushManager = {
    getSubscription: vi.fn(async () => (subscribed ? subscription : null)),
    subscribe: vi.fn(async () => {
      subscribed = true;
      return subscription;
    }),
  };
  const registration = { pushManager };
  const register = vi.fn(async () => registration);
  const requestPermission = vi.fn(async () => "granted");
  vi.stubGlobal("window", {
    isSecureContext: true,
    matchMedia: () => ({ matches: false }),
    PushManager: vi.fn(),
    Notification: vi.fn(),
  });
  vi.stubGlobal("Notification", { permission: "default", requestPermission });
  vi.stubGlobal("navigator", {
    userAgent: "Chromium",
    maxTouchPoints: 0,
    serviceWorker: {
      ready: Promise.resolve(registration),
      register,
      getRegistration: async () => registration,
    },
  });
  return { pushManager, register, requestPermission, unsubscribe };
}

describe("browser push lifecycle", () => {
  it("requests consent and subscribes with decoded key bytes, then exposes and removes the subscription", async () => {
    const browser = installBrowser();
    const result = await subscribeBrowserToWebPush("AAH-_w");

    expect(result).toEqual({
      endpoint: "https://push.example/subscription",
      keys: { p256dh: "public-key", auth: "auth-secret" },
      userAgent: "Chromium",
    });
    expect(browser.requestPermission).toHaveBeenCalledOnce();
    expect(browser.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([0, 1, 254, 255]),
    });
    expect(await getCurrentBrowserPushSubscription()).toEqual(result);
    expect(await unsubscribeBrowserFromWebPush()).toBe(true);
    expect(browser.unsubscribe).toHaveBeenCalledOnce();
  });

  it("reuses an existing subscription without subscribing twice", async () => {
    const browser = installBrowser();
    await subscribeBrowserToWebPush("AAH-_w");
    await subscribeBrowserToWebPush("AAH-_w");
    expect(browser.pushManager.subscribe).toHaveBeenCalledOnce();
  });

  it("does not subscribe when permission is refused", async () => {
    const browser = installBrowser();
    browser.requestPermission.mockResolvedValue("denied");
    await expect(subscribeBrowserToWebPush("AAH-_w")).rejects.toEqual(
      new WebPushError("notification_permission_denied"),
    );
    expect(browser.pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("returns empty subscription state when no registration exists", async () => {
    installBrowser();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration: async () => undefined } });
    expect(await getCurrentBrowserPushSubscription()).toBeNull();
    expect(await unsubscribeBrowserFromWebPush()).toBe(false);
  });

  it("contains registration rejection so bootstrap cannot leak an unhandled promise", async () => {
    const browser = installBrowser();
    browser.register.mockRejectedValue(new DOMException("blocked", "SecurityError"));
    expect(await registerCoxServiceWorker()).toEqual({ status: "failed", error: "blocked" });
  });

  it("registers the root worker with HTTP cache bypass for updates", async () => {
    const browser = installBrowser();
    expect(await registerCoxServiceWorker()).toMatchObject({ status: "registered" });
    expect(browser.register).toHaveBeenCalledWith("/sw.js", { updateViaCache: "none" });
  });

  it.each([undefined, { isSecureContext: false }])(
    "skips unsafe registration in %j",
    async (window) => {
      const browser = installBrowser();
      vi.stubGlobal("window", window);
      expect(await registerCoxServiceWorker()).toEqual({ status: "skipped" });
      expect(browser.register).not.toHaveBeenCalled();
    },
  );
});
