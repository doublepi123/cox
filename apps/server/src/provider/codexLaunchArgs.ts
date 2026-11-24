import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { parse, TomlError } from "smol-toml";

const T3CODE_CODEX_LAUNCH_ARGS_ENV = "T3CODE_CODEX_LAUNCH_ARGS";

export const resolveCodexLaunchArgs = (
  launchArgs?: string,
  environment: NodeJS.ProcessEnv = process.env,
) => {
  const override = environment[T3CODE_CODEX_LAUNCH_ARGS_ENV];
  return override?.trim() ? override : launchArgs?.trim() || "";
};

const codexLaunchArgv = (launchArgs?: string): ReadonlyArray<string> => tokenizeCliArgs(launchArgs);

export const codexAppServerArgs = (launchArgs?: string) => [
  "app-server",
  ...codexLaunchArgv(launchArgs),
];

const codexConfigSetsMemories = (contents: string) => {
  try {
    const { features } = parse(contents);
    return features != null && typeof features === "object" && "memories" in features;
  } catch (error) {
    if (error instanceof TomlError) return true;
    throw error;
  }
};

export const codexSessionAppServerArgs = Effect.fn("codexSessionAppServerArgs")(function* (
  launchArgs: string,
  environment: NodeJS.ProcessEnv,
) {
  const args = codexAppServerArgs(launchArgs);
  const explicitlySet = args.some(
    (arg, index) =>
      /^(?:--enable|--disable)=memories$/u.test(arg) ||
      (/^(?:--enable|--disable)$/u.test(arg) && args[index + 1] === "memories") ||
      /^(?:(?:-c|--config)=?)?features\.memories\s*=/u.test(arg),
  );
  if (explicitlySet) return args;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.CODEX_HOME || path.join(yield* HostProcess.HomeDirectory, ".codex");
  const defaultArgs = ["app-server", "--enable", "memories", ...args.slice(1)];
  const config = yield* fs.readFileString(path.join(home, "config.toml")).pipe(
    Effect.map((contents) => ({ contents })),
    Effect.catch((error) => Effect.succeed(error.reason._tag === "NotFound" ? null : undefined)),
  );
  if (config === null) return defaultArgs;
  return config === undefined || codexConfigSetsMemories(config.contents) ? args : defaultArgs;
});

export const codexExecLaunchArgs = (launchArgs?: string) => {
  const args = codexLaunchArgv(launchArgs);
  const execArgs: Array<string> = [];

  for (let index = 0; index < args.length; index++) {
    const rawArg = args[index];
    if (rawArg === undefined) continue;
    const arg = rawArg.replace(/^(-[cp])(?=[^=])/u, "$1=");

    if (arg === "--strict-config" || arg.startsWith("--config=") || arg.startsWith("-c=")) {
      execArgs.push(arg);
    } else if (arg === "--config" || arg === "-c" || arg === "--enable" || arg === "--disable") {
      const value = args[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        execArgs.push(arg, value);
        index++;
      }
    } else if (arg.startsWith("--enable=") || arg.startsWith("--disable=")) {
      execArgs.push(arg);
    }
  }

  return execArgs;
};
