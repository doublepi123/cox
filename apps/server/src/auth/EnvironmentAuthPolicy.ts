import { AuthEnvironmentMaintainScope, type ServerAuthDescriptor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { isRemoteReachableHost, resolveSessionCookieName } from "./utils.ts";

export class ServerAuthPolicyConfigurationError extends Schema.TaggedError<ServerAuthPolicyConfigurationError>()(
  "ServerAuthPolicyConfigurationError",
  {},
) {
  override get message(): string {
    return "Non-loopback listening requires a configured sign-in password.";
  }
}

export class EnvironmentAuthPolicy extends Context.Service<
  EnvironmentAuthPolicy,
  {
    readonly getDescriptor: () => Effect.Effect<ServerAuthDescriptor>;
  }
>()("cox/auth/EnvironmentAuthPolicy") {}

/** @public */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const isRemoteReachable = isRemoteReachableHost(config.host);

  const policy = isRemoteReachable ? "remote-reachable" : "loopback-browser";
  const passwordLogin =
    config.authPassword !== undefined && Redacted.value(config.authPassword).length > 0;
  if (isRemoteReachable && !passwordLogin) {
    return yield* new ServerAuthPolicyConfigurationError({});
  }

  const descriptor: ServerAuthDescriptor = {
    policy,
    loginMode: passwordLogin ? "password" : "local",
    sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
    serverUpdateScope: AuthEnvironmentMaintainScope,
    sessionCookieName: resolveSessionCookieName({
      mode: config.mode,
      port: config.port,
      host: config.host,
      instanceKey: config.stateDir,
      environmentId: yield* serverEnvironment.getEnvironmentId,
      development: config.devUrl !== undefined,
    }),
    ...(config.authPassword !== undefined && Redacted.value(config.authPassword).length > 0
      ? { passwordLogin: true }
      : {}),
  };

  return EnvironmentAuthPolicy.of({
    getDescriptor: Effect.fn("EnvironmentAuthPolicy.getDescriptor")(function () {
      return Effect.succeed(descriptor);
    }),
  });
});

export const layer = Layer.effect(EnvironmentAuthPolicy, make);
