import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { PrimaryConnectionTarget, type PreparedConnection } from "./model.ts";
import type { ConnectionCatalogEntry } from "./catalog.ts";
export const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("local"),
  label: "Local server",
  httpBaseUrl: "http://127.0.0.1:4773",
  wsBaseUrl: "ws://127.0.0.1:4773",
});
export const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
export const descriptor = {
  environmentId: target.environmentId,
  label: target.label,
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.1.0",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true },
};
export const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: `${target.wsBaseUrl}/ws`,
  httpAuthorization: null,
};
