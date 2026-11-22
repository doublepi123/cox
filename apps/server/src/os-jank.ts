import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  mergePathValues,
  readEnvironmentFromLoginShell,
  readEnvironmentFromLoginShellEffect,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
  setWindowsPath,
  WindowsShellEnvironment,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as CliError from "effect/cli/CliError";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

// mise's record of the PATH entries it added. It must travel with the
// shell's PATH, or `mise x` can rebuild PATH behind a same-named wrapper
// (`exec mise x claude -- claude`) that then re-runs itself forever.
const LOGIN_SHELL_ENVIRONMENT_NAMES = ["PATH", "__MISE_DIFF", "JAVA_HOME", "COX_FEATURE_FLAGS"];
const SLOW_LOGIN_SHELL_TIMEOUT_MS = 20_000;

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellEnvironment: Partial<Record<string, string>> = {};
  let waitedForSlowShell = false;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellEnvironment = readEnvironmentFromLoginShell(shell, LOGIN_SHELL_ENVIRONMENT_NAMES);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
      // A profile can be slow only while the machine boots. Wait for it once,
      // here: providers copy this env when they are built, so a later read
      // would never reach them.
      if (!waitedForSlowShell && (error as NodeJS.ErrnoException | null)?.code === "ETIMEDOUT") {
        waitedForSlowShell = true;
        try {
          shellEnvironment = readEnvironmentFromLoginShell(
            shell,
            LOGIN_SHELL_ENVIRONMENT_NAMES,
            undefined,
            SLOW_LOGIN_SHELL_TIMEOUT_MS,
          );
        } catch (retryError) {
          logPathHydrationWarning(
            `Failed to read PATH from slow login shell ${shell}.`,
            retryError,
          );
        }
      }
    }

    if (shellEnvironment.PATH) break;
  }

  const launchctlPath =
    platform === "darwin" && !shellEnvironment.PATH ? readPathFromLaunchctl() : undefined;
  applyLoginShellEnvironment(env, platform, shellEnvironment, launchctlPath);
}

function applyLoginShellEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  shellEnvironment: Partial<Record<string, string>>,
  launchctlPath?: string,
): void {
  const shellPath = shellEnvironment.PATH;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
  if (shellPath && shellEnvironment.__MISE_DIFF) {
    env.__MISE_DIFF = shellEnvironment.__MISE_DIFF;
  }
  // Android SDK tools are Java programs. A keg-only JDK (Homebrew's openjdk)
  // is only reachable through the JAVA_HOME the shell profile sets.
  if (!env.JAVA_HOME && shellEnvironment.JAVA_HOME) {
    env.JAVA_HOME = shellEnvironment.JAVA_HOME;
  }
  if (env.COX_FEATURE_FLAGS === undefined && shellEnvironment.COX_FEATURE_FLAGS) {
    env.COX_FEATURE_FLAGS = shellEnvironment.COX_FEATURE_FLAGS;
  }
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentPrepared?: boolean | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;

  if (platform === "win32") {
    // Desktop already populated the child env; repeating PowerShell probes costs seconds.
    if (options?.shellEnvironmentPrepared === true) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value === undefined) continue;
      if (key === "PATH") {
        setWindowsPath(env, value);
      } else {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  if (options?.shellEnvironmentPrepared === true) return;
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const refreshHostPath = Effect.fn("refreshHostPath")(function* () {
  const platform = yield* HostProcess.Platform;
  const env = yield* HostProcess.Environment;
  if (platform === "win32") {
    const readEnvironment = yield* WindowsShellEnvironment;
    const { PATH: registryPath } = yield* readEnvironment(["PATH"], { loadProfile: false });
    const currentPath = env.PATH ?? env.Path ?? env.path;
    const mergedPath = mergePathValues(currentPath, registryPath, "win32");
    if (mergedPath && mergedPath !== currentPath) setWindowsPath(env, mergedPath);
    return;
  }
  if (platform !== "darwin" && platform !== "linux") return;
  const [shell] = listLoginShellCandidates(platform, env.SHELL);
  if (!shell) return;
  const shellEnvironment = yield* readEnvironmentFromLoginShellEffect(
    shell,
    LOGIN_SHELL_ENVIRONMENT_NAMES,
  );
  if (shellEnvironment.PATH) applyLoginShellEnvironment(env, platform, shellEnvironment);
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  if (input === "~") {
    return home;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(home, input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const home = yield* HostProcess.HomeDirectory;
  const candidate = raw?.trim()
    ? path.resolve(yield* expandHomePath(raw.trim()))
    : path.join(home, ".cox");
  const canonical = Effect.fn(function* (value: string) {
    let existing = value;
    const suffix: string[] = [];
    for (;;) {
      const real = yield* fs.realPath(existing).pipe(Effect.option);
      if (Option.isSome(real)) return path.join(real.value, ...suffix);
      const parent = path.dirname(existing);
      if (parent === existing) return value;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  });
  const protectedHome = yield* canonical(path.join(home, ".t3"));
  const resolved = yield* canonical(candidate);
  const relative = path.relative(protectedHome, resolved);
  if (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))
  ) {
    return yield* new CliError.UserError({
      cause:
        "Cox refuses to use live ~/.t3 state. Choose ~/.cox or a checkout-local .cox directory.",
    });
  }
  return candidate;
});
