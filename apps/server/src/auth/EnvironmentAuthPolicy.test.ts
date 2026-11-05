import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const layerEnvironmentAuthPolicy = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("EnvironmentAuthPolicy.layer", (it) => {
  it.effect("rejects non-loopback policies without a password even outside the CLI", () =>
    Effect.asVoid(EnvironmentAuthPolicy.EnvironmentAuthPolicy).pipe(
      Effect.provide(layerEnvironmentAuthPolicy({ host: "0.0.0.0" })),
      Effect.flip,
      Effect.map((error) => expect(error._tag).toBe("ServerAuthPolicyConfigurationError")),
    ),
  );

  it.effect("supports explicit non-loopback policies protected by a password", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      expect(yield* policy.getDescriptor()).toMatchObject({
        policy: "remote-reachable",
        loginMode: "password",
      });
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          host: "0.0.0.0",
          authPassword: Redacted.make("test-password"),
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.loginMode).toBe("local");
      expect(descriptor.serverUpdateScope).toBe("environment:maintain");
      expect(descriptor.sessionCookieName).toMatch(/^cox_session_4773_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "127.0.0.1",
          port: 4773,
        }),
      ),
    ),
  );

  it.effect("advertises password login only when a password is configured", () =>
    Effect.gen(function* () {
      const omitting = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      expect((yield* omitting.getDescriptor()).passwordLogin).toBeUndefined();
    }).pipe(Effect.provide(layerEnvironmentAuthPolicy({ mode: "web" }))),
  );

  it.effect("sets passwordLogin when the server has a configured password", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      expect((yield* policy.getDescriptor()).passwordLogin).toBe(true);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          authPassword: Redacted.make("a-configured-password"),
        }),
      ),
    ),
  );
});
