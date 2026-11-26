import type { FileDiffMetadata } from "@pierre/diffs";

import { resolveFileDiffPath } from "~/lib/diffRendering";

export type DiffFileTier = "source" | "test" | "generated";

const GENERATED_FILE_NAMES = new Set([
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "composer.lock",
  "Gemfile.lock",
]);
const GENERATED_DIRECTORIES = new Set([
  "__snapshots__",
  "__generated__",
  "dist",
  "build",
  "vendor",
]);
const TEST_DIRECTORIES = new Set(["__tests__", "tests", "test"]);
const MODULE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function diffFileTier(path: string): DiffFileTier {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  if (
    GENERATED_FILE_NAMES.has(name) ||
    name.endsWith(".snap") ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    /\.generated\./.test(name) ||
    segments.slice(0, -1).some((segment) => GENERATED_DIRECTORIES.has(segment))
  ) {
    return "generated";
  }
  if (
    /\.(?:test|spec)\./.test(name) ||
    segments.slice(0, -1).some((segment) => TEST_DIRECTORIES.has(segment))
  ) {
    return "test";
  }
  return "source";
}

function stripExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(0, dot) : path;
}

function baseName(path: string): string {
  return stripExtension(path.split("/").at(-1) ?? "");
}

function resolveRelative(fromPath: string, specifier: string): string {
  const segments = fromPath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

const IMPORT_SPECIFIER = /(?:\bfrom|\bimport|\brequire\s*\()\s*\(?\s*["']([^"']+)["']/g;

function importedPaths(
  path: string,
  lines: ReadonlyArray<string>,
  byModulePath: ReadonlyMap<string, string>,
  byBaseName: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const imported = new Set<string>();
  for (const line of lines) {
    IMPORT_SPECIFIER.lastIndex = 0;
    let match = IMPORT_SPECIFIER.exec(line);
    while (match !== null) {
      const specifier = match[1] ?? "";
      const withExtension = specifier.startsWith(".")
        ? resolveRelative(path, specifier)
        : specifier;
      // Module-map keys omit extensions, which can differ from disk.
      const extension = MODULE_EXTENSIONS.find((candidate) => withExtension.endsWith(candidate));
      const resolved =
        extension === undefined ? withExtension : withExtension.slice(0, -extension.length);
      const target =
        byModulePath.get(resolved) ??
        byModulePath.get(`${resolved}/index`) ??
        byBaseName.get(baseName(resolved));
      if (target !== undefined && target !== path) imported.add(target);
      match = IMPORT_SPECIFIER.exec(line);
    }
  }
  return imported;
}

function pushMinHeap(heap: Array<number>, value: number): void {
  heap.push(value);
  let child = heap.length - 1;
  while (child > 0) {
    const parent = (child - 1) >> 1;
    const parentValue = heap[parent]!;
    if (parentValue <= value) break;
    heap[child] = parentValue;
    child = parent;
  }
  heap[child] = value;
}

function popMinHeap(heap: Array<number>): number {
  const root = heap[0]!;
  const last = heap.pop()!;
  if (heap.length === 0) return root;
  let parent = 0;
  const half = heap.length >> 1;
  while (parent < half) {
    let child = (parent << 1) + 1;
    let childValue = heap[child]!;
    const right = child + 1;
    if (right < heap.length && heap[right]! < childValue) {
      child = right;
      childValue = heap[right]!;
    }
    if (last <= childValue) break;
    heap[parent] = childValue;
    parent = child;
  }
  heap[parent] = last;
  return root;
}

function orderByImports(
  paths: ReadonlyArray<string>,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
): Array<string> {
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  const count = sorted.length;
  const indexByPath = new Map<string, number>();
  for (let index = 0; index < count; index++) {
    indexByPath.set(sorted[index]!, index);
  }

  const inDegree = new Int32Array(count);
  const emitted = new Uint8Array(count);
  const dependents: Array<Array<number>> = Array.from({ length: count }, () => []);
  for (let index = 0; index < count; index++) {
    const dependencies = imports.get(sorted[index]!);
    if (dependencies === undefined) continue;
    for (const dependency of dependencies) {
      const dependencyIndex = indexByPath.get(dependency);
      if (dependencyIndex === undefined) continue;
      inDegree[index] = inDegree[index]! + 1;
      dependents[dependencyIndex]!.push(index);
    }
  }

  const ready: Array<number> = [];
  for (let index = 0; index < count; index++) {
    if (inDegree[index] === 0) ready.push(index);
  }

  const ordered: Array<string> = [];
  let nextRemaining = 0;
  for (let step = 0; step < count; step++) {
    let nextIndex: number;
    if (ready.length > 0) {
      nextIndex = popMinHeap(ready);
    } else {
      while (emitted[nextRemaining] === 1) nextRemaining++;
      nextIndex = nextRemaining++;
    }
    emitted[nextIndex] = 1;
    ordered.push(sorted[nextIndex]!);

    for (const dependent of dependents[nextIndex]!) {
      if (emitted[dependent] === 1) continue;
      const remainingDependencies = inDegree[dependent]! - 1;
      inDegree[dependent] = remainingDependencies;
      if (remainingDependencies === 0) pushMinHeap(ready, dependent);
    }
  }
  return ordered;
}

function testedSourcePosition(path: string, sourcePositions: ReadonlyMap<string, number>): number {
  let name = (path.split("/").at(-1) ?? "").replace(/\.(?:test|spec)\..*$/, "");
  while (name.length > 0) {
    const position = sourcePositions.get(name);
    if (position !== undefined) return position;
    const dot = name.lastIndexOf(".");
    if (dot <= 0) break;
    name = name.slice(0, dot);
  }
  return Number.MAX_SAFE_INTEGER;
}

export function orderDiffFiles(
  files: ReadonlyArray<FileDiffMetadata>,
): ReadonlyArray<FileDiffMetadata> {
  const byPath = new Map<string, FileDiffMetadata>();
  for (const file of files) byPath.set(resolveFileDiffPath(file), file);
  const tiers = new Map<string, DiffFileTier>();
  for (const path of byPath.keys()) tiers.set(path, diffFileTier(path));

  const sourcePaths = [...byPath.keys()].filter((path) => tiers.get(path) === "source");
  const byModulePath = new Map<string, string>();
  const ambiguousBaseNames = new Set<string>();
  const byBaseName = new Map<string, string>();
  for (const path of sourcePaths) {
    byModulePath.set(stripExtension(path), path);
    const base = baseName(path);
    if (byBaseName.has(base)) ambiguousBaseNames.add(base);
    byBaseName.set(base, path);
  }
  for (const base of ambiguousBaseNames) byBaseName.delete(base);

  const imports = new Map<string, ReadonlySet<string>>();
  for (const path of sourcePaths) {
    const file = byPath.get(path)!;
    imports.set(
      path,
      importedPaths(path, [...file.additionLines, ...file.deletionLines], byModulePath, byBaseName),
    );
  }
  const orderedSource = orderByImports(sourcePaths, imports);

  const sourcePositions = new Map<string, number>();
  orderedSource.forEach((path, index) => {
    const base = baseName(path);
    if (!sourcePositions.has(base)) sourcePositions.set(base, index);
  });
  const orderedTests = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "test")
    .sort((left, right) => {
      const leftPosition = testedSourcePosition(left, sourcePositions);
      const rightPosition = testedSourcePosition(right, sourcePositions);
      return leftPosition - rightPosition || left.localeCompare(right);
    });

  const orderedGenerated = [...byPath.keys()]
    .filter((path) => tiers.get(path) === "generated")
    .sort((left, right) => left.localeCompare(right));

  return [...orderedSource, ...orderedTests, ...orderedGenerated].map((path) => byPath.get(path)!);
}
