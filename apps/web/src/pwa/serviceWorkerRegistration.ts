export type WebPushSupportState =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason:
        | "insecure_context"
        | "ios_requires_standalone_pwa"
        | "service_worker_unavailable"
        | "push_unavailable"
        | "notification_permission_denied";
    };

export type WebPushEnvironment = {
  readonly isSecureContext: boolean;
  readonly userAgent: string;
  readonly maxTouchPoints: number;
  readonly standalone: boolean;
  readonly serviceWorkerAvailable: boolean;
  readonly pushAvailable: boolean;
  readonly notificationPermission: NotificationPermission | undefined;
};

export class InvalidBase64UrlError extends Error {
  constructor() {
    super("Invalid base64url public key");
    this.name = "InvalidBase64UrlError";
  }
}

export class WebPushError extends Error {
  constructor(
    readonly reason:
      | Extract<WebPushSupportState, { supported: false }>["reason"]
      | "subscription_keys_unavailable",
  ) {
    super(`Web Push unavailable: ${reason}`);
    this.name = "WebPushError";
  }
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  if (
    !/^[A-Za-z0-9_-]+={0,2}$/.test(base64String) ||
    base64String.replace(/=+$/, "").length % 4 === 1 ||
    (base64String.includes("=") && base64String.length % 4 !== 0)
  ) {
    throw new InvalidBase64UrlError();
  }
  const unpadded = base64String.replace(/=+$/, "");
  const normalized = unpadded.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  if (btoa(decoded).replace(/=+$/, "") !== normalized) throw new InvalidBase64UrlError();
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

export function getWebPushSupportState(env?: WebPushEnvironment): WebPushSupportState {
  const browser = typeof window !== "undefined" && typeof navigator !== "undefined";
  const environment = env ?? {
    isSecureContext: browser && window.isSecureContext,
    userAgent: browser ? navigator.userAgent : "",
    maxTouchPoints: browser ? navigator.maxTouchPoints : 0,
    standalone:
      browser &&
      (window.matchMedia("(display-mode: standalone)").matches ||
        ("standalone" in navigator && navigator.standalone === true)),
    serviceWorkerAvailable: browser && "serviceWorker" in navigator,
    pushAvailable: browser && "PushManager" in window && "Notification" in window,
    notificationPermission:
      typeof Notification === "undefined" ? undefined : Notification.permission,
  };
  if (!environment.isSecureContext) return { supported: false, reason: "insecure_context" };
  const ios =
    /iPad|iPhone|iPod/.test(environment.userAgent) ||
    (/Macintosh/.test(environment.userAgent) && environment.maxTouchPoints > 1);
  if (ios && !environment.standalone) {
    return { supported: false, reason: "ios_requires_standalone_pwa" };
  }
  if (!environment.serviceWorkerAvailable) {
    return { supported: false, reason: "service_worker_unavailable" };
  }
  if (!environment.pushAvailable) return { supported: false, reason: "push_unavailable" };
  if (environment.notificationPermission === "denied") {
    return { supported: false, reason: "notification_permission_denied" };
  }
  return { supported: true };
}

export async function registerCoxServiceWorker() {
  if (
    typeof window === "undefined" ||
    !window.isSecureContext ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator)
  ) {
    return { status: "skipped" } as const;
  }
  try {
    const registration = await navigator.serviceWorker.register("/sw.js", {
      updateViaCache: "none",
    });
    return { status: "registered", registration } as const;
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    } as const;
  }
}

export type BrowserPushSubscription = {
  readonly endpoint: string;
  readonly keys: { readonly p256dh: string; readonly auth: string };
  readonly userAgent: string;
};

function serializeSubscription(subscription: PushSubscription): BrowserPushSubscription {
  const serialized = subscription.toJSON();
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;
  if (!p256dh || !auth) throw new WebPushError("subscription_keys_unavailable");
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
    userAgent: navigator.userAgent,
  };
}

export async function subscribeBrowserToWebPush(
  vapidPublicKey: string,
): Promise<BrowserPushSubscription> {
  const support = getWebPushSupportState();
  if (!support.supported) throw new WebPushError(support.reason);
  const applicationServerKey = urlBase64ToUint8Array(vapidPublicKey);
  const permission =
    Notification.permission === "default"
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== "granted") throw new WebPushError("notification_permission_denied");
  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
  return serializeSubscription(subscription);
}

export async function unsubscribeBrowserFromWebPush(): Promise<boolean> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return false;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? subscription.unsubscribe() : false;
}

export async function getCurrentBrowserPushSubscription(): Promise<BrowserPushSubscription | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager.getSubscription();
  return subscription ? serializeSubscription(subscription) : null;
}
