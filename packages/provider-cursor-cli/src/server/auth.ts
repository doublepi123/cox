import { ProviderSetupError, type ProviderInstanceId } from "@t3tools/contracts";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import type { CursorCliSettings } from "../settings.ts";
import { cursorCliCommand, cursorCliGlobalArgs } from "./acpSupport.ts";
import { parseCursorCliAbout } from "./status.ts";

const LOGIN_METHOD_ID = "cursor-login";

export function parseCursorCliLoginUrl(output: string): string | undefined {
  const text = output.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "");
  for (const [candidate] of text.matchAll(/https:\/\/[^\s<>"']+/gu)) {
    try {
      const url = new URL(candidate);
      if (url.username || url.password) continue;
      if (url.hostname !== "cursor.com" && !url.hostname.endsWith(".cursor.com")) continue;
      if (!url.pathname.toLowerCase().includes("login")) continue;
      return url.href;
    } catch {
      continue;
    }
  }
  return undefined;
}

export const makeCursorCliAuth = Effect.fn("makeCursorCliAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: Pick<CursorCliSettings, "binaryPath" | "apiEndpoint">;
  readonly enabled: boolean;
  readonly environment: NodeJS.ProcessEnv;
  readonly canStart: Effect.Effect<boolean>;
  readonly onChanged: Effect.Effect<void>;
}) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment: NodeJS.ProcessEnv = {
    ...options.environment,
    NO_COLOR: "1",
    NO_OPEN_BROWSER: "1",
  };
  const usesApiKey = Boolean(environment.CURSOR_API_KEY?.trim());
  const configHome =
    environment.XDG_CONFIG_HOME?.trim() ||
    path.join(
      environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory),
      ".config",
    );
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  const command = Effect.fn("CursorCliAuth.command")(
    function* (args: ReadonlyArray<string>, onOutput?: (text: string) => Effect.Effect<void>) {
      const resolved = yield* resolveSpawnCommand(
        cursorCliCommand(options.settings),
        [...cursorCliGlobalArgs(options.settings), ...args],
        { env: environment },
      );
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
          "Cursor CLI sign-in command failed. Check the CLI installation and try again.",
        );
      return output;
    },
    Effect.scoped,
    Effect.mapError(() =>
      failure(
        "auth",
        "Cursor CLI sign-in command failed. Check the CLI installation and try again.",
      ),
    ),
  );
  const requireAvailable = Effect.gen(function* () {
    if (usesApiKey)
      return yield* failure(
        "auth",
        "This instance uses CURSOR_API_KEY. Remove it from the provider environment to sign in with a Cursor account.",
      );
    if (!options.enabled) return yield* failure("auth", "Enable Cursor CLI before signing in.");
    if (!(yield* options.canStart))
      return yield* failure("auth", "Finish Cursor CLI installation before signing in.");
  });
  return yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: {
      owner: "provider",
      key: `cursorCli:${path.resolve(configHome, "cursor")}`,
    },
    methods: Effect.succeed(
      usesApiKey
        ? []
        : [
            {
              id: LOGIN_METHOD_ID,
              name: "Cursor account",
              description: null,
              type: "agent" as const,
            },
          ],
    ),
    defaultMethodId: LOGIN_METHOD_ID,
    authenticate: Effect.fn("CursorCliAuth.authenticate")(function* (_method, context) {
      yield* requireAvailable;
      let previous: string | undefined;
      yield* command(["login"], (output) => {
        const url = parseCursorCliLoginUrl(output);
        if (url === undefined || url === previous) return Effect.void;
        previous = url;
        return context.setInteraction({
          type: "browser",
          id: LOGIN_METHOD_ID,
          url,
          requiresConsent: false,
        });
      });
      yield* context.verifying;
      const about = yield* command(["about", "--format", "json"]).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => failure("auth", "Could not verify Cursor CLI sign-in. Try again.")),
      );
      if (parseCursorCliAbout(about)?.email === undefined)
        return yield* failure("auth", "Cursor CLI did not confirm sign-in. Start sign-in again.");
      yield* options.onChanged;
    }),
    logout: Effect.gen(function* () {
      yield* requireAvailable;
      yield* command(["logout"]).pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError(() => failure("logout", "Could not sign out of Cursor CLI. Try again.")),
      );
      yield* options.onChanged;
    }),
  });
});
