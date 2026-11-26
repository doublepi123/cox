import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { orderDiffFiles } from "./pullRequestFileOrder.logic";

function file(name: string, additionLines: ReadonlyArray<string> = []): FileDiffMetadata {
  return { name, hunks: [], additionLines, deletionLines: [] } as unknown as FileDiffMetadata;
}

function order(files: ReadonlyArray<FileDiffMetadata>): Array<string> {
  return orderDiffFiles(files).map((entry) => entry.name);
}

describe("orderDiffFiles", () => {
  it("places source before tests and generated files across path conventions", () => {
    const source = ["src/app.ts", "src/dist.ts", "src/testing.ts"];
    const tests = [
      "src/__tests__/app.ts",
      "src/app.spec.tsx",
      "src/app.test.ts",
      "test/app.ts",
      "tests/helpers/app.ts",
    ];
    const generated = [
      "apps/web/package-lock.json",
      "dist/app.js",
      "packages/core/vendor/lib.js",
      "pnpm-lock.yaml",
      "public/app.min.js",
      "src/__snapshots__/app.ts",
      "src/api.generated.ts",
      "src/app.test.ts.snap",
    ];
    expect(
      order([...generated, ...tests, ...source].toReversed().map((path) => file(path))),
    ).toEqual([...source, ...tests, ...generated]);
  });

  it("resolves a specifier that climbs out of the importer's directory", () => {
    expect(
      order([file("src/ui/a.ts", ['import { b } from "../lib/b";']), file("src/lib/b.ts")]),
    ).toEqual(["src/lib/b.ts", "src/ui/a.ts"]);
  });

  it("resolves a directory specifier to that directory's index file", () => {
    expect(
      order([file("src/a.ts", ['import { b } from "./lib";']), file("src/lib/index.ts")]),
    ).toEqual(["src/lib/index.ts", "src/a.ts"]);
  });

  it("falls back to the specifier's last segment when the path does not line up", () => {
    expect(order([file("src/a.ts", ['import { b } from "~/lib/b";']), file("lib/b.ts")])).toEqual([
      "lib/b.ts",
      "src/a.ts",
    ]);
  });

  it("ignores an ambiguous last segment rather than guessing", () => {
    expect(
      order([
        file("src/a.ts", ['import { b } from "~/somewhere/b";']),
        file("one/b.ts"),
        file("two/b.ts"),
      ]),
    ).toEqual(["one/b.ts", "src/a.ts", "two/b.ts"]);
  });

  it("resolves a specifier naming an extension, including the .js beside a .ts", () => {
    expect(order([file("src/a.ts", ['import { b } from "./b.js";']), file("src/b.ts")])).toEqual([
      "src/b.ts",
      "src/a.ts",
    ]);
  });

  it("reads require and bare imports too", () => {
    expect(
      order([
        file("src/a.ts", ['const b = require("./b");', 'import "./c";']),
        file("src/b.ts"),
        file("src/c.ts"),
      ]),
    ).toEqual(["src/b.ts", "src/c.ts", "src/a.ts"]);
  });

  it("falls back to path order inside a cycle", () => {
    expect(
      order([
        file("src/b.ts", ['import { a } from "./a";']),
        file("src/a.ts", ['import { b } from "./b";']),
      ]),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("matches naive lexicographical topological ordering across random cyclic and acyclic graphs", () => {
    function naiveOrderByImports(
      paths: ReadonlyArray<string>,
      imports: ReadonlyMap<string, ReadonlySet<string>>,
    ): Array<string> {
      const remaining = new Set(paths);
      const ordered: Array<string> = [];
      const sorted = [...paths].sort((left, right) => left.localeCompare(right));
      while (remaining.size > 0) {
        const candidates = sorted.filter((path) => remaining.has(path));
        const next =
          candidates.find((path) =>
            [...(imports.get(path) ?? [])].every((dependency) => !remaining.has(dependency)),
          ) ?? candidates[0]!;
        remaining.delete(next);
        ordered.push(next);
      }
      return ordered;
    }

    let seed = 0x5eed1234;
    const nextRand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 0x100000000;
    };

    for (let trial = 0; trial < 30; trial++) {
      const count = 4 + (trial % 15);
      const paths = Array.from({ length: count }, (_, index) => {
        return `src/f${String(index).padStart(2, "0")}.ts`;
      });
      const imports = new Map<string, Set<string>>();
      const files: Array<FileDiffMetadata> = [];
      const edgeProbability = trial % 3 === 0 ? 0.12 : trial % 3 === 1 ? 0.3 : 0.55;

      for (let index = 0; index < count; index++) {
        const deps = new Set<string>();
        const lines: Array<string> = [];
        for (let target = 0; target < count; target++) {
          if (target === index) continue;
          if (nextRand() < edgeProbability) {
            deps.add(paths[target]!);
            lines.push(`import "./f${String(target).padStart(2, "0")}";`);
          }
        }
        imports.set(paths[index]!, deps);
        files.push(file(paths[index]!, lines));
      }

      expect(order(files)).toEqual(naiveOrderByImports(paths, imports));
    }
  });

  it("keeps the tiers apart and orders tests by the source they cover", () => {
    expect(
      order([
        file("pnpm-lock.yaml"),
        file("src/a.test.ts"),
        file("src/__tests__/b.ts"),
        file("src/a.ts", ['import { b } from "./b";']),
        file("src/b.ts"),
        file("dist/a.js"),
      ]),
    ).toEqual([
      "src/b.ts",
      "src/a.ts",
      "src/__tests__/b.ts",
      "src/a.test.ts",
      "dist/a.js",
      "pnpm-lock.yaml",
    ]);
  });

  it("puts a test with no source in the diff after the ones that have theirs", () => {
    expect(order([file("src/orphan.spec.ts"), file("src/a.test.ts"), file("src/a.ts")])).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "src/orphan.spec.ts",
    ]);
  });
});
