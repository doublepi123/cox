import * as NodeModule from "node:module";

import type {
  DirItem,
  FileItem,
  FileFinder as FileFinderType,
  GrepCursor,
  MixedItem,
  Result,
} from "@ff-labs/fff-node";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as LayerMap from "effect/LayerMap";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type {
  ProjectEntry,
  ProjectEntryKind,
  ProjectListEntriesResult,
  ProjectSearchContentsInput,
  ProjectSearchContentsResult,
  ProjectSearchEntriesResult,
} from "@t3tools/contracts";
import { scoreSubsequenceMatch } from "@t3tools/shared/searchRanking";
import { isProjectFaviconPath } from "@t3tools/shared/projectFavicon";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isWithinRoot } from "./KnownWorkspaces.ts";
import { type IgnoreFile, parseIgnoreFile } from "./IgnorePatterns.ts";

// fff-node's native library stays external; single-executables require disk packages instead of importing them.
const requireForFff = NodeModule.createRequire(import.meta.url);
const { FileFinder } = requireForFff("@ff-labs/fff-node") as typeof import("@ff-labs/fff-node");

const WORKSPACE_INDEX_MAX_ENTRIES = 25_000;
const WORKSPACE_INDEX_PAGE_SIZE = WORKSPACE_INDEX_MAX_ENTRIES + 2;
const WORKSPACE_INDEX_SCAN_TIMEOUT = "15 seconds";
const WORKSPACE_INDEX_SCAN_TIMEOUT_MS = 15_000;
const PASSIVE_REFRESH_INTERVAL_MS = 60_000;
const WORKSPACE_INDEX_IDLE_TTL = "15 minutes";
const CONTENT_SEARCH_TIME_BUDGET_MS = 250;
const CONTENT_SEARCH_MAX_MATCHES_PER_FILE = 100;
const FFF_LINE_PREVIEW_BYTES = 512;
const UTF8_MAX_TRAILING_BYTES = 3;

export class WorkspaceSearchIndexCreateFailed extends Schema.TaggedError<WorkspaceSearchIndexCreateFailed>()(
  "WorkspaceSearchIndexCreateFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to create the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexScanTimedOut extends Schema.TaggedError<WorkspaceSearchIndexScanTimedOut>()(
  "WorkspaceSearchIndexScanTimedOut",
  {
    cwd: Schema.String,
    timeout: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace search index for '${this.cwd}' did not finish scanning within ${this.timeout}`;
  }
}

export class WorkspaceSearchIndexSearchFailed extends Schema.TaggedError<WorkspaceSearchIndexSearchFailed>()(
  "WorkspaceSearchIndexSearchFailed",
  {
    cwd: Schema.String,
    queryLength: Schema.Number,
    pageSize: Schema.Number,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workspace search failed for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexRefreshFailed extends Schema.TaggedError<WorkspaceSearchIndexRefreshFailed>()(
  "WorkspaceSearchIndexRefreshFailed",
  {
    cwd: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to refresh the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndexDestroyFailed extends Schema.TaggedError<WorkspaceSearchIndexDestroyFailed>()(
  "WorkspaceSearchIndexDestroyFailed",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to destroy the workspace search index for '${this.cwd}'.`;
  }
}

export class WorkspaceSearchIndex extends Context.Service<
  WorkspaceSearchIndex,
  {
    readonly list: () => Effect.Effect<ProjectListEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly search: (
      query: string,
      limit: number,
      kind?: ProjectEntryKind,
      imageOnly?: boolean,
    ) => Effect.Effect<ProjectSearchEntriesResult, WorkspaceSearchIndexSearchFailed>;
    readonly searchContents: (
      input: Omit<ProjectSearchContentsInput, "cwd">,
    ) => Effect.Effect<ProjectSearchContentsResult, WorkspaceSearchIndexSearchFailed>;
    readonly refresh: (
      mode?: "passive",
    ) => Effect.Effect<void, WorkspaceSearchIndexRefreshFailed | WorkspaceSearchIndexScanTimedOut>;
  }
>()("cox/workspace/WorkspaceSearchIndex") {}

function toPosixPath(input: string): string {
  return process.platform === "win32" ? input.replaceAll("\\", "/") : input;
}

function trimDirectorySeparator(input: string): string {
  return input.endsWith("/") ? input.slice(0, -1) : input;
}

function parentPathOf(input: string): string | undefined {
  const separatorIndex = input.lastIndexOf("/");
  return separatorIndex === -1 ? undefined : input.slice(0, separatorIndex);
}

function toProjectEntry(item: MixedItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.item.relativePath));
  if (!normalizedPath) {
    return null;
  }

  return {
    path: normalizedPath,
    kind: item.type,
  };
}

function toFileEntry(item: FileItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "file" } : null;
}

function toDirectoryEntry(item: DirItem): ProjectEntry | null {
  const normalizedPath = trimDirectorySeparator(toPosixPath(item.relativePath));
  return normalizedPath ? { path: normalizedPath, kind: "directory" } : null;
}

type SearchPage<I> = { readonly items: ReadonlyArray<I>; readonly totalMatched: number };

function mapFileSearchResult(
  result: SearchPage<FileItem>,
  limit: number,
  imageOnly = false,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toFileEntry(item);
    return entry && (!imageOnly || isProjectFaviconPath(entry.path)) ? [entry] : [];
  });
  return {
    entries: entries.slice(0, limit),
    truncated: entries.length > limit || result.totalMatched > result.items.length,
  };
}

function mapDirectorySearchResult(
  result: SearchPage<DirItem>,
  limit: number,
): ProjectSearchEntriesResult {
  const entries = result.items.flatMap((item) => {
    const entry = toDirectoryEntry(item);
    return entry ? [entry] : [];
  });
  const rootDirectoryCount = result.items.some((item) => item.relativePath.length === 0) ? 1 : 0;
  return {
    entries: entries.slice(0, limit),
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

function mapMixedSearchResult(
  result: SearchPage<MixedItem>,
  limit: number,
): { readonly entries: ProjectEntry[]; readonly truncated: boolean } {
  const entries: ProjectEntry[] = [];
  for (const item of result.items) {
    const entry = toProjectEntry(item);
    if (entry) {
      entries.push(entry);
    }
    if (entries.length >= limit) {
      break;
    }
  }

  const rootDirectoryCount = result.items.some(
    (item) => item.type === "directory" && item.item.relativePath.length === 0,
  )
    ? 1
    : 0;
  return {
    entries,
    truncated: result.totalMatched - rootDirectoryCount > limit,
  };
}

const WORD_CHARACTER = /[\p{Letter}\p{Mark}\p{Number}_]/u;

function codePointAt(line: string, index: number): string | undefined {
  const codePoint = line.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(line: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previousCodeUnit = line.charCodeAt(index - 1);
  const previousIndex =
    previousCodeUnit >= 0xdc00 && previousCodeUnit <= 0xdfff ? index - 2 : index - 1;
  return codePointAt(line, previousIndex);
}

const ASCII_WORD = /^\w+$/;

function buildWholeWordPattern(query: string, caseSensitive: boolean): string {
  return `(?${caseSensitive ? "" : "i"}-u)\\b${query}\\b`;
}

function findWordRanges(
  line: string,
  word: string,
  caseSensitive: boolean,
): Array<{ readonly start: number; readonly end: number }> {
  return Array.from(line.matchAll(new RegExp(word, caseSensitive ? "g" : "gi")), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function buildContentSearchQuery(input: Omit<ProjectSearchContentsInput, "cwd">): {
  readonly searchQuery: string;
  readonly regexMode: boolean;
} {
  if (input.caseSensitive) {
    return { searchQuery: input.query, regexMode: input.useRegex };
  }
  return input.useRegex
    ? { searchQuery: `(?i)${input.query}`, regexMode: true }
    : { searchQuery: input.query.toLowerCase(), regexMode: false };
}

function mapContentMatchRanges(
  line: string,
  byteRanges: ReadonlyArray<readonly [number, number]>,
): Array<{ readonly start: number; readonly end: number }> {
  const lineBytes = Buffer.from(line);
  const toStringIndex = (byteOffset: number) => lineBytes.subarray(0, byteOffset).toString().length;
  return byteRanges.map(([startByte, endByte]) => ({
    start: toStringIndex(startByte),
    end: toStringIndex(endByte),
  }));
}

// Post-filter whole words: consuming boundary regexes swallow adjacent separators and widen ranges; \b misses punctuation edges.
function isWholeWordRange(
  line: string,
  range: { readonly start: number; readonly end: number },
): boolean {
  if (range.end <= range.start) return false;
  const isWord = (character: string | undefined) =>
    character !== undefined && WORD_CHARACTER.test(character);
  const leftIsBoundary =
    range.start === 0 ||
    !isWord(codePointBefore(line, range.start)) ||
    !isWord(codePointAt(line, range.start));
  const rightIsBoundary =
    range.end >= line.length ||
    !isWord(codePointAt(line, range.end)) ||
    !isWord(codePointBefore(line, range.end));
  return leftIsBoundary && rightIsBoundary;
}

function withDirectoryAncestors(entries: ReadonlyArray<ProjectEntry>): ProjectEntry[] {
  const entryByPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const entry of entries) {
    let parentPath = parentPathOf(entry.path);
    while (parentPath) {
      if (!entryByPath.has(parentPath)) {
        entryByPath.set(parentPath, { path: parentPath, kind: "directory" });
      }
      parentPath = parentPathOf(parentPath);
    }
  }
  return [...entryByPath.values()];
}

// fff applies .gitignore files only; Git also ignores paths from .git/info/exclude and the global excludes file.
const listGitIgnoredPaths = Effect.fn("WorkspaceSearchIndex.listGitIgnoredPaths")(function* (
  vcsProcess: VcsProcess.VcsProcess["Service"],
  cwd: string,
) {
  const result = yield* vcsProcess
    .run({
      operation: "WorkspaceSearchIndex.listGitIgnoredPaths",
      command: "git",
      args: [
        "-c",
        "core.fsmonitor=false",
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ],
      cwd,
      allowNonZeroExit: true,
      timeoutMs: 10_000,
      maxOutputBytes: 16 * 1024 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (!result || result.exitCode !== 0 || result.stdoutTruncated) return [];
  return result.stdout.split("\0").filter(Boolean).map(toPosixPath);
});

function mixedItemPath(item: MixedItem): string {
  return item.item.relativePath;
}

function isIgnoredPath(ignoredPaths: ReadonlySet<string>, relativePath: string): boolean {
  if (ignoredPaths.size === 0) return false;
  let candidate: string | undefined = trimDirectorySeparator(toPosixPath(relativePath));
  while (candidate) {
    if (ignoredPaths.has(candidate)) return true;
    candidate = parentPathOf(candidate);
  }
  return false;
}

const createFinder = Effect.fn("WorkspaceSearchIndex.createFinder")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant,
) {
  const result = yield* Effect.try({
    try: () =>
      FileFinder.create({
        basePath: cwd,
        disableMmapCache: true,
        // Content indexing costs CPU/memory; path-only consumers use the lightweight index.
        disableContentIndexing: variant !== "content",
        aiMode: false,
        enableFsRootScanning: true,
        enableHomeDirScanning: true,
      }),
    catch: (cause) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason: "FileFinder.create threw unexpectedly.",
        cause,
      }),
  });
  if (result.ok) return result.value;
  return yield* new WorkspaceSearchIndexCreateFailed({
    cwd,
    reason: result.error,
  });
});

const waitForIndexReady = Effect.fn("WorkspaceSearchIndex.waitForIndexReady")(function* <E>(
  cwd: string,
  finder: FileFinderType,
  onFailure: (input: { readonly reason: string; readonly cause?: unknown }) => E,
): Effect.fn.Return<void, E | WorkspaceSearchIndexScanTimedOut> {
  const result = yield* Effect.tryPromise({
    try: () => finder.waitForIndexReady(WORKSPACE_INDEX_SCAN_TIMEOUT_MS),
    catch: (cause) =>
      onFailure({
        reason: "FileFinder.waitForIndexReady rejected unexpectedly.",
        cause,
      }),
  });
  if (!result.ok) {
    return yield* Effect.fail(onFailure({ reason: result.error }));
  }
  if (!result.value) {
    return yield* new WorkspaceSearchIndexScanTimedOut({
      cwd,
      timeout: WORKSPACE_INDEX_SCAN_TIMEOUT,
    });
  }
});

export const make = Effect.fn("WorkspaceSearchIndex.make")(function* (
  cwd: string,
  variant: WorkspaceSearchIndexVariant = "paths",
) {
  const finder = yield* Effect.acquireRelease(createFinder(cwd, variant), (finder) =>
    Effect.try({
      try: () => finder.destroy(),
      catch: (cause) => new WorkspaceSearchIndexDestroyFailed({ cwd, cause }),
    }).pipe(Effect.orDie),
  );
  let initialScanTimedOut = false;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const makeIgnoreFileDecider = () => {
    const ignoreFiles = new Map<string, IgnoreFile | undefined>();
    const readIgnoreFile = Effect.fn("WorkspaceSearchIndex.readIgnoreFile")(function* (
      directory: string,
    ) {
      if (ignoreFiles.has(directory)) return ignoreFiles.get(directory);
      const contents = yield* fileSystem
        .readFileString(path.join(cwd, directory, ".ignore"))
        .pipe(Effect.option);
      const file = Option.isSome(contents) ? parseIgnoreFile(contents.value) : undefined;
      ignoreFiles.set(directory, file);
      return file;
    });
    return Effect.fn("WorkspaceSearchIndex.decideByIgnoreFile")(function* (
      relativePath: string,
      isFolder: boolean,
    ) {
      const segments = relativePath.split("/");
      for (let ancestor = segments.length - 1; ancestor >= 0; ancestor -= 1) {
        const directory = segments.slice(0, ancestor).join("/");
        const file = yield* readIgnoreFile(directory);
        const relative = directory ? relativePath.slice(directory.length + 1) : relativePath;
        const decision = file?.decide(relative, isFolder);
        if (decision) return decision;
      }
      return undefined;
    });
  };

  const loadIgnoredPaths = Effect.fn("WorkspaceSearchIndex.loadIgnoredPaths")(function* () {
    const decide = makeIgnoreFileDecider();
    const ignored = new Set<string>();
    for (const entry of yield* listGitIgnoredPaths(vcsProcess, cwd)) {
      const relativePath = trimDirectorySeparator(entry);
      if ((yield* decide(relativePath, entry.endsWith("/"))) !== "included") {
        ignored.add(relativePath);
      }
    }
    return ignored;
  });
  let ignoredPaths = yield* loadIgnoredPaths();
  yield* waitForIndexReady(
    cwd,
    finder,
    ({ reason, cause }) =>
      new WorkspaceSearchIndexCreateFailed({
        cwd,
        reason,
        cause,
      }),
  ).pipe(
    Effect.catchTags({
      WorkspaceSearchIndexScanTimedOut: (error) =>
        variant === "paths"
          ? Effect.sync(() => {
              initialScanTimedOut = true;
            })
          : Effect.fail(error),
    }),
  );

  const hasIncompleteInitialScan = () => initialScanTimedOut && finder.isScanning();

  const runSearch = Effect.fn("WorkspaceSearchIndex.runSearch")(function* <A>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "grep" | "mixedSearch",
    execute: () => Result<A>,
  ): Effect.fn.Return<A, WorkspaceSearchIndexSearchFailed> {
    const result = yield* Effect.try({
      try: execute,
      catch: (cause) =>
        new WorkspaceSearchIndexSearchFailed({
          cwd,
          queryLength: query.length,
          pageSize,
          reason: `FileFinder.${operation} threw unexpectedly.`,
          cause,
        }),
    });
    if (!result.ok) {
      return yield* new WorkspaceSearchIndexSearchFailed({
        cwd,
        queryLength: query.length,
        pageSize,
        reason: result.error,
      });
    }
    return result.value;
  });

  // Grows the first page until hidden entries can no longer crowd visible ones out of it.
  const searchVisible = Effect.fn("WorkspaceSearchIndex.searchVisible")(function* <I>(
    query: string,
    pageSize: number,
    operation: "directorySearch" | "fileSearch" | "mixedSearch",
    execute: (pageSize: number) => Result<SearchPage<I>>,
    pathOf: (item: I) => string,
  ): Effect.fn.Return<SearchPage<I>, WorkspaceSearchIndexSearchFailed> {
    let size = pageSize;
    while (true) {
      const fetchSize = size;
      const result = yield* runSearch(query, fetchSize, operation, () => execute(fetchSize));
      if (ignoredPaths.size === 0) return result;
      const items = result.items.filter((item) => !isIgnoredPath(ignoredPaths, pathOf(item)));
      if (
        items.length >= pageSize ||
        result.items.length >= result.totalMatched ||
        fetchSize >= WORKSPACE_INDEX_PAGE_SIZE
      ) {
        return {
          items,
          totalMatched: result.totalMatched - (result.items.length - items.length),
        };
      }
      size = Math.min(WORKSPACE_INDEX_PAGE_SIZE, fetchSize * 4);
    }
  });

  const scanSymlinks = Effect.fn("WorkspaceSearchIndex.scanSymlinks")(function* () {
    const root = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => null));
    if (root === null) return [];
    const indexed = yield* runSearch("", WORKSPACE_INDEX_PAGE_SIZE, "directorySearch", () =>
      finder.directorySearch("", { pageSize: WORKSPACE_INDEX_PAGE_SIZE }),
    ).pipe(Effect.orElseSucceed(() => null));
    const directories = new Set(["", ...(indexed?.items ?? []).map((item) => item.relativePath)]);
    const scanned = yield* Effect.forEach(
      directories,
      (directory) =>
        fileSystem.readDirectoryEntries(path.join(root, directory)).pipe(
          Effect.map((entries) => ({ directory, entries })),
          Effect.orElseSucceed(() => ({ directory, entries: [] })),
        ),
      { concurrency: 16 },
    );
    const repositories = new Set(
      scanned
        .filter(({ entries }) => entries.some((entry) => entry.name === ".git"))
        .map(({ directory }) => directory),
    );
    const candidates = scanned.flatMap(({ directory, entries }) =>
      entries.flatMap((entry) =>
        entry.type === "SymbolicLink" && entry.name !== ".git"
          ? [directory ? directory + "/" + entry.name : entry.name]
          : [],
      ),
    );
    const decision = makeIgnoreFileDecider();
    const links = (yield* Effect.forEach(
      candidates,
      Effect.fnUntraced(function* (relativePath) {
        const target = yield* fileSystem
          .realPath(path.join(root, relativePath))
          .pipe(Effect.orElseSucceed(() => null));
        if (
          target === null ||
          !isWithinRoot(path, target, root) ||
          path.relative(root, target).split(path.sep).includes(".git")
        )
          return null;
        const stat = yield* fileSystem.stat(target).pipe(Effect.orElseSucceed(() => null));
        const kind =
          stat?.type === "File" ? "file" : stat?.type === "Directory" ? "directory" : null;
        if (kind === null || (yield* decision(relativePath, kind === "directory")) === "ignored")
          return null;
        return { path: relativePath, kind } satisfies ProjectEntry;
      }),
      { concurrency: 16 },
    )).filter((entry) => entry !== null);
    const byRepository = Map.groupBy(links, (entry) => {
      for (let dir = parentPathOf(entry.path); dir !== undefined; dir = parentPathOf(dir)) {
        if (repositories.has(dir)) return dir;
      }
      return "";
    });
    const visible = yield* Effect.forEach(
      byRepository,
      ([repository, entries]) =>
        Effect.gen(function* () {
          const prefix = repository === "" ? "" : repository + "/";
          // ./ avoids leading : pathspec magic; check-ignore rejects --literal-pathspecs.
          const relative = entries.map((entry) => "./" + entry.path.slice(prefix.length));
          const result = yield* vcsProcess
            .run({
              operation: "WorkspaceSearchIndex.listGitIgnored",
              command: "git",
              args: ["-c", "core.fsmonitor=false", "check-ignore", "--no-index", "-z", "--stdin"],
              cwd: path.join(root, repository),
              stdin: relative.join("\0") + "\0",
              allowNonZeroExit: true,
              timeoutMs: 10_000,
              maxOutputBytes: 16 * 1024 * 1024,
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          const ignored = new Set(result?.exitCode === 0 ? result.stdout.split("\0") : []);
          return entries.filter((entry, index) => !ignored.has(relative[index]!));
        }),
      { concurrency: 4 },
    );
    return visible.flat();
  });
  let symlinks = yield* Effect.cached(scanSymlinks());

  const refreshPermit = yield* Semaphore.make(1);
  let lastRefreshStartedAt: number | undefined;
  const refresh: WorkspaceSearchIndex["Service"]["refresh"] = Effect.fn(
    "WorkspaceSearchIndex.refresh",
  )(
    function* (mode) {
      const now = yield* Clock.currentTimeMillis;
      if (
        mode === "passive" &&
        ((lastRefreshStartedAt !== undefined &&
          now - lastRefreshStartedAt < PASSIVE_REFRESH_INTERVAL_MS) ||
          finder.isScanning())
      )
        return;
      // scanFiles waits on fff's picker lock, which its watcher can hold for seconds.
      const result = yield* Effect.tryPromise({
        try: () => finder.scanFilesAsync(),
        catch: (cause) =>
          new WorkspaceSearchIndexRefreshFailed({
            cwd,
            reason: "FileFinder.scanFilesAsync rejected unexpectedly.",
            cause,
          }),
      });
      if (!result.ok) {
        return yield* new WorkspaceSearchIndexRefreshFailed({
          cwd,
          reason: result.error,
        });
      }
      lastRefreshStartedAt = now;
      yield* waitForIndexReady(
        cwd,
        finder,
        ({ reason, cause }) =>
          new WorkspaceSearchIndexRefreshFailed({
            cwd,
            reason,
            cause,
          }),
      );
      ignoredPaths = yield* loadIgnoredPaths();
      symlinks = yield* Effect.cached(scanSymlinks());
    },
    (effect, mode) =>
      mode === "passive"
        ? refreshPermit.withPermitsIfAvailable(1)(effect).pipe(Effect.asVoid)
        : refreshPermit.withPermit(effect),
  );

  const list: WorkspaceSearchIndex["Service"]["list"] = Effect.fn("WorkspaceSearchIndex.list")(
    function* () {
      const incompleteBeforeQuery = hasIncompleteInitialScan();
      const result = yield* searchVisible(
        "",
        WORKSPACE_INDEX_PAGE_SIZE,
        "mixedSearch",
        (pageSize) => finder.mixedSearch("", { pageSize }),
        mixedItemPath,
      );
      const mapped = mapMixedSearchResult(result, WORKSPACE_INDEX_MAX_ENTRIES);
      const sortedEntries = withDirectoryAncestors([
        ...mapped.entries,
        ...(yield* symlinks),
      ]).toSorted((left, right) => left.path.localeCompare(right.path));
      const entries = sortedEntries.slice(0, WORKSPACE_INDEX_MAX_ENTRIES);
      return {
        entries,
        truncated:
          incompleteBeforeQuery || mapped.truncated || entries.length < sortedEntries.length,
      };
    },
  );

  const searchNames = Effect.fn("WorkspaceSearchIndex.searchNames")(function* (
    query: string,
    limit: number,
    kind: ProjectEntryKind | undefined,
    imageOnly: boolean | undefined,
  ) {
    const pageSize = imageOnly ? WORKSPACE_INDEX_PAGE_SIZE : Math.max(1, limit + 1);
    if (kind === "file" || imageOnly) {
      const result = yield* searchVisible(
        query,
        pageSize,
        "fileSearch",
        (size) => finder.fileSearch(query, { pageSize: size }),
        (item) => item.relativePath,
      );
      return mapFileSearchResult(result, limit, imageOnly);
    }
    if (kind === "directory") {
      const result = yield* searchVisible(
        query,
        pageSize,
        "directorySearch",
        (size) => finder.directorySearch(query, { pageSize: size }),
        (item) => item.relativePath,
      );
      return mapDirectorySearchResult(result, limit);
    }
    const result = yield* searchVisible(
      query,
      pageSize,
      "mixedSearch",
      (size) => finder.mixedSearch(query, { pageSize: size }),
      mixedItemPath,
    );
    return mapMixedSearchResult(result, limit);
  });

  const search: WorkspaceSearchIndex["Service"]["search"] = Effect.fn(
    "WorkspaceSearchIndex.search",
  )(function* (query, limit, kind, imageOnly) {
    const incompleteBeforeQuery = hasIncompleteInitialScan();
    let result = yield* searchNames(query, limit, kind, imageOnly);
    if (result.entries.length === 0 && query.includes("{")) {
      result = yield* searchNames(query.replaceAll("{", ""), limit, kind, imageOnly);
    }
    const queryText = query.toLowerCase();
    const links = (yield* symlinks).filter(
      (entry) =>
        (kind === undefined || entry.kind === kind) &&
        (!imageOnly || (entry.kind === "file" && isProjectFaviconPath(entry.path))) &&
        (queryText === "" || scoreSubsequenceMatch(entry.path.toLowerCase(), queryText) !== null),
    );
    const byPath = new Map([...result.entries, ...links].map((entry) => [entry.path, entry]));
    return {
      entries: [...byPath.values()].slice(0, limit),
      truncated: incompleteBeforeQuery || result.truncated || byPath.size > limit,
    };
  });

  const searchContents: WorkspaceSearchIndex["Service"]["searchContents"] = Effect.fn(
    "WorkspaceSearchIndex.searchContents",
  )(function* (input) {
    const wholeWordPrefilter = input.wholeWord && !input.useRegex && ASCII_WORD.test(input.query);
    let { searchQuery, regexMode } = wholeWordPrefilter
      ? { searchQuery: buildWholeWordPattern(input.query, input.caseSensitive), regexMode: true }
      : buildContentSearchQuery(input);
    const nativeWholeWordRegex =
      input.wholeWord &&
      input.useRegex &&
      /^[\w+*?{}| -]+$/u.test(input.query) &&
      /^\w.*\w$/u.test(input.query) &&
      !input.query.includes("|");
    if (nativeWholeWordRegex) {
      searchQuery = `${input.caseSensitive ? "" : "(?i)"}\\b(?:${input.query})\\b`;
    }
    const deadline = performance.now() + CONTENT_SEARCH_TIME_BUDGET_MS;
    // Grep cursors advance per file; whole-word filtering needs enough raw candidates before advancing.
    const rawPageSize = input.wholeWord
      ? Math.max(input.limit, CONTENT_SEARCH_MAX_MATCHES_PER_FILE)
      : input.limit;
    const matches: Array<ProjectSearchContentsResult["matches"][number]> = [];
    let nextCursor: GrepCursor | null = null;
    let regexFallbackError: string | undefined;
    let retryLiterally = false;

    do {
      const remainingTimeBudgetMs = Math.max(1, Math.ceil(deadline - performance.now()));
      const result = yield* runSearch(input.query, input.limit, "grep", () =>
        finder.grep(searchQuery, {
          mode: regexMode ? "regex" : "plain",
          smartCase: !input.caseSensitive && !regexMode,
          maxMatchesPerFile: Math.min(CONTENT_SEARCH_MAX_MATCHES_PER_FILE, rawPageSize),
          pageSize: rawPageSize,
          cursor: nextCursor,
          timeBudgetMs: remainingTimeBudgetMs,
        }),
      );
      retryLiterally = regexMode && !input.caseSensitive && result.regexFallbackError !== undefined;
      if (retryLiterally) {
        regexFallbackError = result.regexFallbackError;
        ({ searchQuery, regexMode } = buildContentSearchQuery({ ...input, useRegex: false }));
        continue;
      }

      for (const match of result.items) {
        if (isIgnoredPath(ignoredPaths, match.relativePath)) continue;
        const capped =
          Buffer.byteLength(match.lineContent) >= FFF_LINE_PREVIEW_BYTES - UTF8_MAX_TRAILING_BYTES;
        const matchRanges = (
          wholeWordPrefilter
            ? findWordRanges(match.lineContent, input.query, input.caseSensitive)
            : mapContentMatchRanges(match.lineContent, match.matchRanges)
        ).filter(
          (range) =>
            (!capped || range.end < match.lineContent.length) &&
            (!input.wholeWord || isWholeWordRange(match.lineContent, range)),
        );
        if (
          input.wholeWord &&
          matchRanges.length === 0 &&
          !(
            capped &&
            match.matchRanges.length === 0 &&
            !retryLiterally &&
            (wholeWordPrefilter || nativeWholeWordRegex)
          )
        )
          continue;
        matches.push({
          path: toPosixPath(match.relativePath),
          lineNumber: match.lineNumber,
          lineContent: match.lineContent,
          matchRanges,
        });
      }
      nextCursor = result.nextCursor;
      regexFallbackError ??= result.regexFallbackError;
    } while (
      retryLiterally ||
      (matches.length < input.limit && nextCursor !== null && performance.now() < deadline)
    );

    return {
      matches: matches.slice(0, input.limit),
      truncated: matches.length > input.limit || nextCursor !== null,
      ...(regexFallbackError !== undefined ? { regexFallbackError } : {}),
    };
  });

  return WorkspaceSearchIndex.of({ list, refresh, search, searchContents });
});

export const WORKSPACE_SEARCH_INDEX_VARIANTS = ["paths", "content"] as const;
export type WorkspaceSearchIndexVariant = (typeof WORKSPACE_SEARCH_INDEX_VARIANTS)[number];

export const workspaceSearchIndexKey = (cwd: string, variant: WorkspaceSearchIndexVariant) =>
  `${variant}\n${cwd}`;

function parseWorkspaceSearchIndexKey(key: string): {
  readonly cwd: string;
  readonly variant: WorkspaceSearchIndexVariant;
} {
  const separatorIndex = key.indexOf("\n");
  return {
    variant: key.slice(0, separatorIndex) as WorkspaceSearchIndexVariant,
    cwd: key.slice(separatorIndex + 1),
  };
}

/** @public */
export const layer = (key: string) => {
  const { cwd, variant } = parseWorkspaceSearchIndexKey(key);
  return Layer.effect(WorkspaceSearchIndex, make(cwd, variant));
};

export class WorkspaceSearchIndexMap extends LayerMap.Service<WorkspaceSearchIndexMap>()(
  "cox/workspace/WorkspaceSearchIndexMap",
  {
    lookup: layer,
    idleTimeToLive: WORKSPACE_INDEX_IDLE_TTL,
  },
) {}
