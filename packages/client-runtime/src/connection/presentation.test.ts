import { expect, it } from "vite-plus/test";
import { entry } from "./localTestFixtures.ts";
import { AVAILABLE_CONNECTION_STATE } from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  environmentMcpUrl,
  presentConnectionState,
} from "./presentation.ts";
it("presents local server URLs", () => {
  expect(connectionCatalogDisplayUrl(entry)).toBe(entry.target.httpBaseUrl);
  expect(environmentMcpUrl({ entry })).toBe(`${entry.target.httpBaseUrl}/mcp`);
});
it("presents local connection status", () => {
  expect(presentConnectionState({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }).phase).toBe(
    "connected",
  );
  expect(
    presentConnectionState({ ...AVAILABLE_CONNECTION_STATE, network: "offline", phase: "offline" })
      .phase,
  ).toBe("offline");
});
