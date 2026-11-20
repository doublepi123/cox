import * as Schema from "effect/Schema";

import { readLocalStorageValue, writeLocalStorageValue } from "~/hooks/useLocalStorage";

const expansionStorageKey = "cox:file-tree-expansion:v1";
const expansionStorageSchema = Schema.Array(
  Schema.Struct({ root: Schema.String, paths: Schema.Array(Schema.String) }),
);

export function readExpandedDirectories(root: string): readonly string[] {
  return (
    readLocalStorageValue(expansionStorageKey, [], expansionStorageSchema).find(
      (entry) => entry.root === root,
    )?.paths ?? []
  );
}

export function writeExpandedDirectories(root: string, paths: readonly string[]): void {
  writeLocalStorageValue(
    expansionStorageKey,
    (previous) => {
      const others = previous.filter((entry) => entry.root !== root);
      return (paths.length > 0 ? [{ root, paths }, ...others] : others).slice(0, 20);
    },
    [],
    expansionStorageSchema,
  );
}

export interface FileTreeExpansionModel {
  getItem(path: string): unknown;
}

type DirectoryHandle = {
  isDirectory(): boolean;
  isExpanded(): boolean;
  expand(): void;
  collapse(): void;
};

function asDirectoryHandle(item: unknown): DirectoryHandle | null {
  if (
    typeof item !== "object" ||
    item === null ||
    !("isDirectory" in item) ||
    typeof item.isDirectory !== "function" ||
    !item.isDirectory() ||
    !("isExpanded" in item) ||
    typeof item.isExpanded !== "function" ||
    !("expand" in item) ||
    typeof item.expand !== "function" ||
    !("collapse" in item) ||
    typeof item.collapse !== "function"
  ) {
    return null;
  }
  return item as DirectoryHandle;
}

export function areAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
): boolean {
  return (
    directoryPaths.length > 0 &&
    directoryPaths.every((path) => {
      const item = asDirectoryHandle(model.getItem(path));
      return item !== null && item.isExpanded();
    })
  );
}

export function setAllDirectoriesExpanded(
  model: FileTreeExpansionModel,
  directoryPaths: readonly string[],
  expanded: boolean,
): void {
  for (const path of directoryPaths) {
    const item = asDirectoryHandle(model.getItem(path));
    if (item === null || item.isExpanded() === expanded) continue;
    if (expanded) item.expand();
    else item.collapse();
  }
}
