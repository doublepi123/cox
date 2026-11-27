// @effect-diagnostics nodeBuiltinImport:off - the guarded file read needs open
// flags (O_NOFOLLOW, O_NONBLOCK) the FileSystem service does not expose.

import * as NodeFS from "node:fs";

import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { lock } from "proper-lockfile";
import * as ServerConfig from "./config.ts";
import { watchDirectoryPath } from "./watchDirectoryReplacements.ts";

const decodeEnvironmentThemeFileJsonExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(EnvironmentThemeFile),
);
const isEnvironmentThemeId = Schema.is(EnvironmentThemeId);

const THEME_FILE_SUFFIX = ".json";

const MAX_THEME_FILES = 32;
/** Shared with publishing so it cannot accept files the watcher skips. */
export const MAX_THEME_FILE_BYTES = 32 * 1024;
const MAX_THEME_TOTAL_BYTES = 192 * 1024;

interface PublishedThemes {
  readonly seq: number;
  readonly themes: ReadonlyArray<EnvironmentTheme>;
}

export class EnvironmentThemeService extends Context.Service<
  EnvironmentThemeService,
  {
    readonly current: Effect.Effect<ReadonlyArray<EnvironmentTheme>>;

    /** Subscribes before reading to retain changes during connection. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<EnvironmentTheme>>;
  }
>()("cox/environmentTheme/EnvironmentThemeService") {}

/** Validates and reads one handle; rejects symlinked files, allows symlinked directories.
 * Uses non-blocking opens against FIFOs; Windows lacks these flags and checks symlinks with lstat. */
export const readThemeFileGuarded = (
  filePath: string,
  maxBytes: number,
  onMissing?: () => void,
): string | null => {
  let fd: number;
  try {
    if (NodeFS.constants.O_NOFOLLOW === undefined && NodeFS.lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    fd = NodeFS.openSync(
      filePath,
      NodeFS.constants.O_RDONLY |
        (NodeFS.constants.O_NOFOLLOW ?? 0) |
        (NodeFS.constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") onMissing?.();
    return null;
  }
  try {
    const info = NodeFS.fstatSync(fd);
    if (!info.isFile() || info.size > maxBytes) return null;
    const contents = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < contents.length) {
      const read = NodeFS.readSync(fd, contents, offset, contents.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return new TextDecoder().decode(contents.subarray(0, offset));
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
};

export class EnvironmentThemeRefusedError extends Schema.TaggedError<EnvironmentThemeRefusedError>()(
  "EnvironmentThemeRefusedError",
  { themeId: Schema.String, problem: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Theme "${this.themeId}" ${this.problem}`;
  }
}

/**
 * Hold through the settings write so CLI and server publishers share one catalog snapshot.
 * Returns a guard that skips a rollback once a stalled holder has lost the lock to another.
 */
export const acquireThemePublishLock = Effect.fn("EnvironmentTheme.acquirePublishLock")(function* (
  themesDir: string,
  themeId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .makeDirectory(themesDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentThemeRefusedError({ themeId, problem: "could not be published.", cause }),
      ),
    );
  let compromised = false;
  yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        lock(themesDir, {
          lockfilePath: `${themesDir}/.cox-theme-publish.lock`,
          stale: 60_000,
          onCompromised: () => {
            compromised = true;
          },
        }),
      catch: (cause) =>
        new EnvironmentThemeRefusedError({
          themeId,
          problem:
            (cause as { code?: unknown } | null)?.code === "ELOCKED"
              ? "could not be published because the themes directory is busy. Try again."
              : "could not be published.",
          cause,
        }),
    }),
    (release) => Effect.promise(() => release().catch(() => undefined)),
  );
  return (rollback: Effect.Effect<void>) =>
    Effect.suspend(() => (compromised ? Effect.void : rollback));
});

export const readPublishedThemes = Effect.fn(function* (
  themesDir: string,
  onPathMissing: Effect.Effect<void> = Effect.void,
) {
  const fs = yield* FileSystem.FileSystem;
  const entries = yield* Effect.catch(fs.readDirectory(themesDir), (error) =>
    Effect.as(error.reason._tag === "NotFound" ? onPathMissing : Effect.void, []),
  );
  let listedFileMissing = false;
  const markListedFileMissing = () => {
    listedFileMissing = true;
  };

  const themes: Array<EnvironmentTheme> = [];
  let examined = 0;
  let totalBytes = 0;
  for (const entry of entries.toSorted()) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    // Reserved ids shadow built-ins or capture clients that never chose them.
    if (!isEnvironmentThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    // Cap examined files, not accepted themes, to bound work on malformed directories.
    examined += 1;
    if (examined > MAX_THEME_FILES) {
      yield* Effect.logWarning("ignoring environment theme files past the limit", {
        path: themesDir,
        limit: MAX_THEME_FILES,
      });
      break;
    }

    const filePath = `${themesDir}/${entry}`;
    const raw = readThemeFileGuarded(filePath, MAX_THEME_FILE_BYTES, markListedFileMissing);
    if (raw === null) {
      yield* Effect.logWarning("ignoring unusable environment theme file", {
        path: filePath,
        limit: MAX_THEME_FILE_BYTES,
      });
      continue;
    }
    if (raw.trim().length === 0) continue;

    const decoded = decodeEnvironmentThemeFileJsonExit(raw);
    if (decoded._tag === "Failure") {
      yield* Effect.logWarning("ignoring invalid environment theme", {
        path: filePath,
        detail: Cause.pretty(decoded.cause),
      });
      continue;
    }
    const file = decoded.value;
    if (!environmentThemeFileHasColors(file)) {
      yield* Effect.logWarning("ignoring environment theme without colors", { path: filePath });
      continue;
    }

    totalBytes += Buffer.byteLength(raw);
    if (totalBytes > MAX_THEME_TOTAL_BYTES) {
      yield* Effect.logWarning("ignoring environment themes past the total size limit", {
        path: themesDir,
        limit: MAX_THEME_TOTAL_BYTES,
      });
      break;
    }

    themes.push({ id, ...file });
  }
  if (listedFileMissing) yield* onPathMissing;
  return themes;
});

const make = Effect.gen(function* () {
  const { environmentThemesDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  // Sequence numbers let subscribers drop queued events older than their initial snapshot.
  const changes = yield* PubSub.sliding<PublishedThemes>(1);
  const published = yield* Ref.make<PublishedThemes>({ seq: 0, themes: [] });
  const pathMissing = yield* Ref.make(false);
  // Serialize read/compare/publish so slow older reads cannot publish with newer sequence numbers.
  const refreshSemaphore = yield* Semaphore.make(1);
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const refresh = refreshSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const themes = yield* readPublishedThemes(
        environmentThemesDir,
        Ref.set(pathMissing, true),
      ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
      // Compare the whole value so new fields cannot silently miss republishes.
      const [changed, next] = yield* Ref.modify(
        published,
        (previous): readonly [readonly [boolean, PublishedThemes], PublishedThemes] => {
          if (Equal.equals(previous.themes, themes)) return [[false, previous], previous];
          const updated: PublishedThemes = { seq: previous.seq + 1, themes };
          return [[true, updated], updated];
        },
      );
      if (changed) yield* PubSub.publish(changes, next).pipe(Effect.asVoid);
      return next;
    }),
  );

  yield* fs
    .makeDirectory(environmentThemesDir, { recursive: true })
    .pipe(Effect.ignoreCause({ log: true }));

  const watchDirectory = (directory: string) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const markReady = () => Deferred.doneUnsafe(ready, Exit.void);
        const events = fs.watch(directory, { onReady: markReady }).pipe(
          Stream.as(undefined),
          Stream.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Stream.empty,
          ),
          Stream.ignoreCause({ log: true }),
          Stream.ensuring(Effect.sync(markReady)),
        );
        return Stream.merge(events, Stream.fromEffect(Deferred.await(ready)));
      }),
    );

  const watchEvents = watchDirectoryPath(
    environmentThemesDir,
    watchDirectory(environmentThemesDir),
    Ref.getAndSet(pathMissing, false),
  ).pipe(
    // A save emits several events, and fs.watch can fire before content is flushed.
    Stream.debounce(Duration.millis(100)),
  );

  yield* refresh;
  yield* Stream.runForEach(watchEvents, () => refresh.pipe(Effect.ignoreCause({ log: true }))).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkIn(watcherScope),
    Effect.asVoid,
  );

  return {
    current: Effect.map(refresh, (state) => state.themes),
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* refresh;
          return Stream.concat(
            Stream.make(snapshot.themes),
            Stream.fromSubscription(subscription).pipe(
              Stream.filter((update) => update.seq > snapshot.seq),
              Stream.map((update) => update.themes),
            ),
          );
        }),
      );
    },
  } satisfies EnvironmentThemeService["Service"];
});

export const layer = Layer.effect(EnvironmentThemeService, make);
