import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";

export type ConnectionRouteKind = "loopback";
export function connectionRouteId(_target: ConnectionTarget): string {
  return "primary";
}
export function connectionRoutes(entry: ConnectionCatalogEntry): ReadonlyArray<ConnectionRoute> {
  return [{ target: entry.target, profile: entry.profile }];
}
export function routeHttpBaseUrl(route: ConnectionRoute): string {
  return route.target.httpBaseUrl;
}
export function connectionRouteKind(_route: ConnectionRoute): ConnectionRouteKind {
  return "loopback";
}
export function connectionRouteLabel(_route: ConnectionRoute): string {
  return "Local server";
}
export function connectionRouteAddress(route: ConnectionRoute): string {
  return route.target.httpBaseUrl;
}
