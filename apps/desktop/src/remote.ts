import { randomUUID } from "node:crypto";

export interface RemoteServerInspection {
  readonly origin: string;
  readonly environmentId: string;
  readonly label: string;
  readonly serverVersion: string;
}

export interface RemoteConnectionInput {
  readonly id?: string;
  readonly name?: string;
  readonly origin?: string;
  readonly openInNewWindow?: boolean;
}

export function normalizeRemoteOrigin(input: string): string {
  const url = new URL(input.trim());
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter an HTTPS server origin without credentials, a path, query, or fragment.",
    );
  return url.origin;
}

export function remoteProfileId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value))
    throw new Error("Invalid remote server identity.");
  return value.toLowerCase();
}

export function remotePartition(id: string): string {
  return `persist:cox-remote-${remoteProfileId(id)}`;
}

export function newRemoteProfileId(): string {
  return randomUUID();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class RemoteGatewayRequiredError extends Error {
  readonly origin: string;
  constructor(origin: string) {
    super("Sign in to Cloudflare Access to connect to this server.");
    this.origin = origin;
  }
}

export function isCloudflareAccessGate(origin: string, status: number, headers: Headers): boolean {
  if (status >= 300 && status < 400) {
    const location = headers.get("location");
    if (!location) return false;
    try {
      const target = new URL(location, origin);
      return (
        target.protocol === "https:" &&
        (target.hostname.toLowerCase().endsWith(".cloudflareaccess.com") ||
          (target.origin === origin && target.pathname.startsWith("/cdn-cgi/access/")))
      );
    } catch {
      return false;
    }
  }
  if (status !== 401 && status !== 403) return false;
  return (
    [...headers.keys()].some((name) => name.startsWith("cf-access-")) ||
    /Cloudflare-Access/i.test(headers.get("www-authenticate") ?? "")
  );
}

export function isCloudflareAccessUrl(target: string): boolean {
  try {
    const url = new URL(target);
    return (
      url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".cloudflareaccess.com")
    );
  } catch {
    return false;
  }
}

async function readJson(
  fetcher: typeof fetch,
  origin: string,
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/json" },
    redirect: "manual",
    signal,
  });
  if (isCloudflareAccessGate(origin, response.status, response.headers))
    throw new RemoteGatewayRequiredError(origin);
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400))
    throw new Error("Remote server redirected the request. Enter the server's final HTTPS origin.");
  if (!response.ok) throw new Error(`Remote server returned HTTP ${response.status}.`);
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("Remote server response is too large.");
  return JSON.parse(text) as unknown;
}

export async function inspectRemoteServer(
  originInput: string,
  fetcher: typeof fetch = fetch,
  signal = AbortSignal.timeout(15_000),
): Promise<RemoteServerInspection> {
  const origin = normalizeRemoteOrigin(originInput);
  const descriptor = record(
    await readJson(fetcher, origin, `${origin}/.well-known/t3/environment`, signal),
  );
  if (
    !descriptor ||
    !nonEmptyString(descriptor.environmentId) ||
    !nonEmptyString(descriptor.label) ||
    !nonEmptyString(descriptor.serverVersion)
  )
    throw new Error("The server did not return a valid Cox environment descriptor.");
  const session = record(await readJson(fetcher, origin, `${origin}/api/auth/session`, signal));
  const auth = record(session?.auth);
  if (auth?.loginMode !== "password")
    throw new Error("Remote Cox servers must enable COX_AUTH_PASSWORD.");
  return {
    origin,
    environmentId: descriptor.environmentId,
    label: descriptor.label.trim(),
    serverVersion: descriptor.serverVersion.trim(),
  };
}
