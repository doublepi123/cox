import {
  FileFinder,
  type FileItem,
  type GrepCursor,
  type GrepOptions,
  type GrepResult,
} from "@ff-labs/fff-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import { vi } from "vite-plus/test";

import * as WorkspaceSearchIndex from "./WorkspaceSearchIndex.ts";
import * as VcsProcessModule from "../vcs/VcsProcess.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

function fileItem(relativePath: string): FileItem {
  return {
    relativePath,
    fileName: relativePath.slice(relativePath.lastIndexOf("/") + 1),
    size: 1,
    modified: 0,
    accessFrecencyScore: 0,
    modificationFrecencyScore: 0,
    totalFrecencyScore: 0,
    gitStatus: "clean",
  };
}

it.effect("filters image searches before applying the result limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const items = [
        ...Array.from({ length: 200 }, (_, index) => fileItem(`src/file-${index}.ts`)),
        fileItem("public/icon.svg"),
      ];
      const fileSearch = vi.fn(() => ({
        ok: true as const,
        value: {
          items,
          scores: [],
          totalMatched: items.length,
          totalFiles: items.length,
        },
      }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        fileSearch,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project").pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(VcsProcess, {
          run: () =>
            Effect.succeed({
              exitCode: ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      );
      const resultWithoutKind = yield* searchIndex.search("", 200, undefined, true);
      const resultWithDirectoryKind = yield* searchIndex.search("", 200, "directory", true);

      expect(resultWithoutKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(resultWithDirectoryKind.entries).toEqual([{ kind: "file", path: "public/icon.svg" }]);
      expect(fileSearch).toHaveBeenCalledTimes(2);
      expect(fileSearch).toHaveBeenCalledWith("", { pageSize: 25_002 });
    }),
  ),
);

it.effect("continues whole-word searches after a filtered grep page", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nextCursor = {
        __brand: "GrepCursor",
        _offset: 1,
      } as GrepCursor;
      const grepResult = (
        lineContent: string,
        matchRanges: Array<[number, number]>,
        cursor: GrepCursor | null,
      ): GrepResult => ({
        items: [
          {
            relativePath: "src/words.ts",
            fileName: "words.ts",
            gitStatus: "unmodified",
            size: lineContent.length,
            modified: 0,
            isBinary: false,
            totalFrecencyScore: 0,
            accessFrecencyScore: 0,
            modificationFrecencyScore: 0,
            lineNumber: 1,
            col: 0,
            byteOffset: 0,
            lineContent,
            matchRanges,
          },
        ],
        totalMatched: 1,
        totalFilesSearched: 1,
        totalFiles: 1,
        filteredFileCount: 1,
        nextCursor: cursor,
      });
      const grep = vi.fn((_query: string, options?: GrepOptions) =>
        options?.cursor
          ? { ok: true as const, value: grepResult("needle", [[0, 6]], null) }
          : {
              ok: true as const,
              value: grepResult("needleSuffix", [[0, 6]], nextCursor),
            },
      );
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        grep,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project", "content").pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(VcsProcess, {
          run: () =>
            Effect.succeed({
              exitCode: ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      );
      const result = yield* searchIndex.searchContents({
        query: "needle",
        limit: 1,
        caseSensitive: true,
        wholeWord: true,
        useRegex: false,
      });

      expect(result).toEqual({
        matches: [
          {
            path: "src/words.ts",
            lineNumber: 1,
            lineContent: "needle",
            matchRanges: [{ start: 0, end: 6 }],
          },
        ],
        truncated: false,
      });
      expect(grep).toHaveBeenCalledTimes(2);
      expect(grep.mock.calls[1]?.[1]?.cursor).toBe(nextCursor);
    }),
  ),
);

it.live("checks whole lines while returning only visible match ranges", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cox-long-lines-" });
      yield* fs.writeFileString(
        path.join(cwd, "long.ts"),
        [
          `${" ".repeat(600)}token`,
          `${" ".repeat(507)}tokenized`,
          `é token ${"d".repeat(600)} token`,
          `é tokenized${" ".repeat(600)}token`,
        ].join("\r\n"),
      );
      const searchIndex = yield* WorkspaceSearchIndex.make(cwd, "content");
      const search = (query: string, wholeWord: boolean, useRegex: boolean) =>
        searchIndex
          .searchContents({ query, wholeWord, useRegex, limit: 20, caseSensitive: true })
          .pipe(
            Effect.map(({ matches }) =>
              matches.map(({ lineNumber, matchRanges }) => [lineNumber, matchRanges]),
            ),
          );
      const words = [
        [1, []],
        [3, [{ start: 2, end: 7 }]],
        [4, []],
      ];
      expect(yield* search("token", true, false)).toEqual(words);
      expect(yield* search("tok+en", true, true)).toEqual(words);
      expect(yield* search("tok+en\\w*", false, true)).toEqual([
        [1, []],
        [2, []],
        [3, [{ start: 2, end: 7 }]],
        [4, [{ start: 2, end: 11 }]],
      ]);
    }).pipe(Effect.provide(VcsProcessModule.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  ),
);

it.effect("refreshes the index through FFF's asynchronous scan", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scanFilesAsync = vi.fn(async () => ({ ok: true as const, value: undefined }));
      const finder = {
        destroy: vi.fn(),
        waitForIndexReady: vi.fn(async () => ({ ok: true as const, value: true })),
        scanFilesAsync,
      } as unknown as FileFinder;
      vi.spyOn(FileFinder, "create").mockReturnValueOnce({ ok: true, value: finder });

      const searchIndex = yield* WorkspaceSearchIndex.make("/workspace/project").pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(VcsProcess, {
          run: () =>
            Effect.succeed({
              exitCode: ExitCode(0),
              stdout: "",
              stderr: "",
              stdoutTruncated: false,
              stderrTruncated: false,
            }),
        }),
      );
      yield* searchIndex.refresh();

      expect(scanFilesAsync).toHaveBeenCalledOnce();
    }),
  ),
);

it.effect("keeps symlinks Git does not ignore when a link's name looks like a git pathspec", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const vcs = yield* VcsProcess;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "cox-symlink-pathspec-" });
    const git = (...args: string[]) =>
      vcs.run({ operation: "test.git", command: "git", args, cwd });
    yield* git("init");
    yield* fs.writeFileString(path.join(cwd, ".gitignore"), "ignored-link\n");
    yield* fs.writeFileString(path.join(cwd, "a.ts"), "");
    for (const link of ["docs-link", ":(link)", "ignored-link"]) {
      yield* fs.symlink("a.ts", path.join(cwd, link));
    }
    yield* git("add", "-f", "ignored-link");
    const searchIndex = yield* WorkspaceSearchIndex.make(cwd);
    const listed = yield* searchIndex.list();
    expect(listed.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining([":(link)", "docs-link"]),
    );
    expect(listed.entries.map((entry) => entry.path)).not.toContain("ignored-link");
    expect((yield* searchIndex.search(":(link)", 10, "file")).entries).toContainEqual({
      path: ":(link)",
      kind: "file",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(VcsProcessModule.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);
