// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/** New packages provide bin/claude.exe; older packages need a JavaScript runtime for cli.js. */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/** On Windows the SDK skips shell and PATH/PATHEXT lookup: bare names and .cmd shims fail. */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32") {
      return binaryPath;
    }

    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;
    const resolved =
      (yield* Effect.promise(async () => resolveExecutable(binaryPath, platform, environment))) ??
      binaryPath;
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return binaryPath;
  },
);

/**
 * Returns an effect reading the real path of the installed Claude binary.
 * Updates repoint the installed link to a new version file, so comparing this
 * detects when a live CLI process was started from an older version.
 */
export const claudeProgramReader = Effect.fn("claudeProgramReader")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<Effect.Effect<string | undefined>> {
  const platform = yield* HostProcess.Platform;
  const resolveExecutable = yield* SpawnExecutableResolution;
  return Effect.promise(async () => {
    try {
      const resolved = await resolveExecutable(binaryPath, platform, environment);
      return resolved === undefined ? undefined : await NodeFS.promises.realpath(resolved);
    } catch {
      return undefined;
    }
  });
});

/**
 * Reports whether an update replaced the program a live CLI process started
 * from. An unreadable path on either side reports no update.
 */
export const claudeProgramWasReplaced = (
  startedFrom: string | undefined,
  now: string | undefined,
): boolean => startedFrom !== undefined && now !== undefined && startedFrom !== now;
