import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSymlinkTarget } from "@t3tools/shared/symlink";

/** Windows open-file locks block renames; the same codes can mean permanent denial, so bound retries. */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// Bound denial delays to about two seconds because settings saves hold their write lock.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";

const isUnsupportedSync = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS";
};

/** Resolves symlink targets before renaming so writes preserve the link. */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetPath = yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      // Cleanup failure must not fail a write that already landed.
      const tempDirectory = yield* Effect.acquireRelease(
        fs.makeTempDirectory({
          directory: targetDirectory,
          prefix: `${path.basename(targetPath)}.`,
        }),
        (directory) => fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
      );
      const tempPath = path.join(tempDirectory, "contents.tmp");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(tempPath, { flag: "w" });
          yield* file.writeAll(new TextEncoder().encode(input.contents));
          if (platform !== "win32") {
            const mode = yield* fs.stat(targetPath).pipe(
              Effect.map((info) => info.mode & 0o777),
              Effect.catchIf(
                (error) => error.reason._tag === "NotFound",
                () => Effect.succeed(0o600),
              ),
            );
            yield* fs.chmod(tempPath, mode);
          }
          yield* file.sync;
        }),
      );
      if (platform !== "win32") {
        yield* fs.rename(tempPath, targetPath);
        return yield* fs.open(targetDirectory, { flag: "r" }).pipe(
          Effect.flatMap((directory) => directory.sync),
          Effect.scoped,
          Effect.catchIf(
            (error) => error.reason._tag === "PermissionDenied" || isUnsupportedSync(error),
            (error) => Effect.logWarning(error),
          ),
        );
      }

      // Stop retrying if another save changes the target; read-only targets also return permanent EPERM.
      const targetVersion = fs.stat(targetPath).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
