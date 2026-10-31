export interface PrimaryEnvironmentTarget {
  readonly source: "window-origin";
  readonly target: {
    readonly httpBaseUrl: string;
    readonly wsBaseUrl: string;
  };
}

export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.replace(/^\[|\]$/g, "").toLowerCase());
}

export function readPrimaryEnvironmentTarget(): PrimaryEnvironmentTarget {
  const url = new URL(window.location.origin);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Cox must be opened from its local HTTP server.");
  }
  const httpBaseUrl = url.toString();
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return { source: "window-origin", target: { httpBaseUrl, wsBaseUrl: url.toString() } };
}

export function resolvePrimaryEnvironmentHttpUrl(
  pathname: string,
  searchParams?: Record<string, string>,
): string {
  const url = new URL(readPrimaryEnvironmentTarget().target.httpBaseUrl);
  url.pathname = pathname;
  if (searchParams) url.search = new URLSearchParams(searchParams).toString();
  return url.toString();
}
