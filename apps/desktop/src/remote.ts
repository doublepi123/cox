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
}

export function normalizeRemoteOrigin(input: string): string {
  const url = new URL(input.trim());
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Enter an HTTP(S) server origin without credentials, a path, query, or fragment.",
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

async function readJson(fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    headers: { accept: "application/json" },
    redirect: "error",
    signal,
  });
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
    await readJson(fetcher, `${origin}/.well-known/t3/environment`, signal),
  );
  if (
    !descriptor ||
    !nonEmptyString(descriptor.environmentId) ||
    !nonEmptyString(descriptor.label) ||
    !nonEmptyString(descriptor.serverVersion)
  )
    throw new Error("The server did not return a valid Cox environment descriptor.");
  const session = record(await readJson(fetcher, `${origin}/api/auth/session`, signal));
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
