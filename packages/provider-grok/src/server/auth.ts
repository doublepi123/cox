import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { parseGrokModelsCliOutput } from "./status.ts";

export function parseGrokDeviceLogin(
  output: string,
): { readonly url: string; readonly userCode: string } | undefined {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  for (const [candidate] of text.matchAll(/https:\/\/[^\s<>"']+/g)) {
    try {
      const url = new URL(candidate);
      const userCode =
        url.searchParams.get("user_code") ?? text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
      if (!userCode || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) || url.username || url.password)
        continue;
      if (!url.searchParams.has("user_code") && !url.pathname.endsWith("/device")) continue;
      return { url: url.href, userCode };
    } catch {
      continue;
    }
  }
}

export const makeGrokAuth = Effect.fn("makeGrokAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly canStart: Effect.Effect<boolean>;
  readonly onChanged: Effect.Effect<void>;
}) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    GROK_DISABLE_AUTOUPDATER: "1",
    NO_COLOR: "1",
    BROWSER: "false",
  };
  const usesApiKey = Boolean(environment.XAI_API_KEY?.trim());
  const home =
    environment.GROK_HOME?.trim() ||
    path.join(
      environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".grok",
    );
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const command = Effect.fn("GrokAuth.command")(
    function* (args: ReadonlyArray<string>, onOutput?: (text: string) => Effect.Effect<void>) {
      const resolved = yield* resolveSpawnCommand(options.binaryPath || "grok", args, {
        env: environment,
      });
      const child = yield* spawner.spawn(
        ChildProcess.make(resolved.command, resolved.args, {
          env: environment,
          shell: resolved.shell,
          stdin: "ignore",
        }),
      );
      let output = "";
      const collect = (stream: typeof child.stdout) =>
        stream.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            output = (output + chunk).slice(-16_384);
            return onOutput?.(output) ?? Effect.void;
          }),
        );
      const [, , code] = yield* Effect.all(
        [collect(child.stdout), collect(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* failure(
          "auth",
          "Grok sign-in command failed. Check the CLI installation and try again.",
        );
      return output;
    },
    Effect.scoped,
    Effect.mapError(() =>
      failure("auth", "Grok sign-in command failed. Check the CLI installation and try again."),
    ),
  );
  const requireAvailable = Effect.gen(function* () {
    if (usesApiKey)
      return yield* failure(
        "auth",
        "This instance uses XAI_API_KEY. Remove it from the provider environment to sign in with a Grok account.",
      );
    if (!options.enabled) return yield* failure("auth", "Enable Grok before signing in.");
    if (!(yield* options.canStart))
      return yield* failure("auth", "Finish Grok installation before signing in.");
  });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: {
      owner: "provider",
      key: `grok:${path.resolve(home)}:${environment.GROK_CONFIG_PATH ?? ""}:${environment.GROK_CONFIG ?? ""}`,
    },
    methods: Effect.succeed(
      usesApiKey
        ? []
        : [{ id: "device-code", name: "Grok account", description: null, type: "agent" as const }],
    ),
    defaultMethodId: "device-code",
    authenticate: Effect.fn("GrokAuth.authenticate")(function* (_method, context) {
      yield* requireAvailable;
      let previous = "";
      yield* command(["login", "--device-auth"], (output) => {
        const login = parseGrokDeviceLogin(output);
        if (!login || login.url === previous) return Effect.void;
        previous = login.url;
        return context.setInteraction({ type: "deviceCode", id: "device-code", ...login });
      });
      yield* context.verifying;
      const result = yield* command(["models"]).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => failure("auth", "Could not verify Grok sign-in. Try again.")),
      );
      if (parseGrokModelsCliOutput(result).authenticated !== true)
        return yield* failure("auth", "Grok did not confirm sign-in. Start sign-in again.");
      yield* options.onChanged;
    }),
    logout: Effect.gen(function* () {
      yield* requireAvailable;
      yield* command(["logout"]).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(() => failure("logout", "Could not sign out of Grok. Try again.")),
      );
      yield* options.onChanged;
    }),
  });
});
