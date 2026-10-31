import { expect, it } from "vite-plus/test";
import { entry, target } from "./localTestFixtures.ts";
import { connectionRoutes, connectionRouteKind, connectionRouteAddress } from "./routes.ts";
it("exposes only the co-hosted local route", () => {
  const routes = connectionRoutes(entry);
  expect(routes).toHaveLength(1);
  expect(routes[0]?.target).toEqual(target);
  expect(connectionRouteKind(routes[0]!)).toBe("loopback");
  expect(connectionRouteAddress(routes[0]!)).toBe(target.httpBaseUrl);
});
