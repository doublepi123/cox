import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as ServerConfig from "./config.ts";
import {
  formatHeadlessServeOutput,
  resolveHeadlessConnectionString,
  resolveHeadlessServeAccessInfo,
} from "./startupAccess.ts";
it("formats loopback addresses for the local browser", () => {
  expect(resolveHeadlessConnectionString(undefined, 4773)).toBe("http://127.0.0.1:4773");
  expect(resolveHeadlessConnectionString("::1", 4773)).toBe("http://[::1]:4773");
  expect(resolveHeadlessConnectionString("0.0.0.0", 4773)).toBe("http://127.0.0.1:4773");
  expect(resolveHeadlessConnectionString("::", 4773)).toBe("http://127.0.0.1:4773");
});

for (const loginMode of ["local", "password"] as const) {
  it.effect("resolves " + loginMode + " access without an authentication issuer", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const accessInfo = yield* resolveHeadlessServeAccessInfo().pipe(
        Effect.provideService(ServerConfig.ServerConfig, {
          ...config,
          authPassword: loginMode === "password" ? Redacted.make("cox-password") : undefined,
        }),
        Effect.provide(
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 4774),
          }),
        ),
      );
      expect(accessInfo).toEqual({
        connectionString: "http://127.0.0.1:4774",
        loginMode,
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest("/", { prefix: "cox-startup-access-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
      Effect.scoped,
    ),
  );
  it("prints only URL and login mode for " + loginMode, () => {
    const output = formatHeadlessServeOutput({
      connectionString: "http://127.0.0.1:4773",
      loginMode,
    });
    expect(output).toContain("Local URL: http://127.0.0.1:4773");
    expect(output).toContain("Login mode: " + loginMode);
    expect(output.split("\n")).toHaveLength(2);
    expect(output).not.toMatch(/token|pair/i);
  });
}
