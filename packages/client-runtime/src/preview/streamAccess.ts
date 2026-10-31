import * as Effect from "effect/Effect";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";

export interface BrowserStreamAccess {
  readonly httpBase: string;
  readonly wsBase: string;
  readonly query: Readonly<Record<string, string>>;
  readonly credentials: boolean;
}

export function withBrowserStreamQuery(rawUrl: string, access: BrowserStreamAccess): string {
  const url = new URL(rawUrl);
  for (const [key, value] of Object.entries(access.query)) url.searchParams.set(key, value);
  return url.toString();
}

export const resolveBrowserStreamAccess = Effect.fn(
  "clientRuntime.preview.resolveBrowserStreamAccess",
)(function* (input: { readonly prepared: PreparedConnection; readonly hubBasePath: string }) {
  const httpBase = environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath);
  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    query: {},
    credentials: true,
  } satisfies BrowserStreamAccess;
});
