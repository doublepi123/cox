interface NotificationThreadRouter {
  readonly navigate: (options: { readonly href: string }) => Promise<unknown>;
}

function validSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === ".." || segment.length > 256) return false;
  try {
    const decoded = decodeURIComponent(segment);
    return !/[/\\\u0000-\u0020\u007f]/.test(decoded);
  } catch {
    return false;
  }
}

export function sanitizeNotificationThreadPath(
  value: unknown,
  origin = window.location.origin,
): string | null {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u0020\u007f]/.test(value)
  ) {
    return null;
  }
  const target = new URL(value, origin);
  if (target.origin !== origin || target.pathname.startsWith("/settings/")) return null;
  const segments = target.pathname.split("/");
  if (segments.length !== 3 || segments[0] !== "") return null;
  const environmentId = segments[1];
  const threadId = segments[2];
  if (
    environmentId === undefined ||
    threadId === undefined ||
    !validSegment(environmentId) ||
    !validSegment(threadId)
  ) {
    return null;
  }
  return `${target.pathname}${target.search}${target.hash}`;
}

function messageThreadPath(data: unknown): unknown {
  if (typeof data !== "object" || data === null || !("type" in data)) return undefined;
  if (data.type !== "cox:navigate-thread" || !("threadPath" in data)) return undefined;
  return data.threadPath;
}

export function startNotificationDeepLinkNavigation(router: NotificationThreadRouter) {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => undefined;
  const onMessage = (event: MessageEvent) => {
    const threadPath = sanitizeNotificationThreadPath(messageThreadPath(event.data));
    if (threadPath) void router.navigate({ href: threadPath });
  };
  navigator.serviceWorker.addEventListener("message", onMessage);
  return () => navigator.serviceWorker.removeEventListener("message", onMessage);
}
