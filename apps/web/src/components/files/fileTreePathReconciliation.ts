import type { FileTreeBatchOperation } from "@pierre/trees";

const rebuildCostInSiblingOperations = 300;

function siblingCounts(paths: readonly string[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const parent = parentPath(path);
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return counts;
}

function parentPath(path: string): string {
  const end = path.endsWith("/") ? path.length - 1 : path.length;
  return path.slice(0, Math.max(0, path.lastIndexOf("/", end - 1)));
}

export function shouldRebuildFileTree(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
  updates: readonly FileTreeBatchOperation[],
): boolean {
  if (updates.length <= rebuildCostInSiblingOperations) return false;
  const previousCounts = siblingCounts(previousPaths);
  const nextCounts = siblingCounts(nextPaths);
  const rebuildCost =
    rebuildCostInSiblingOperations * Math.max(previousPaths.length, nextPaths.length);
  let batchCost = 0;
  for (const update of updates) {
    if (update.type !== "add" && update.type !== "remove") continue;
    const parent = parentPath(update.path);
    batchCost += Math.max(previousCounts.get(parent) ?? 0, nextCounts.get(parent) ?? 0);
    if (batchCost > rebuildCost) return true;
  }
  return false;
}

function pathDepth(path: string): number {
  return path.split("/").filter(Boolean).length;
}

export function buildFileTreePathUpdates(
  previousPaths: readonly string[],
  nextPaths: readonly string[],
): FileTreeBatchOperation[] {
  const previous = new Set(previousPaths);
  const next = new Set(nextPaths);
  const removedDirectoryRoots = new Set<string>();
  const updates: FileTreeBatchOperation[] = [];

  const removedPaths = previousPaths
    .filter((path) => !next.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of removedPaths) {
    let removedAncestor = false;
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (!removedDirectoryRoots.has(path.slice(0, slash + 1))) continue;
      removedAncestor = true;
      break;
    }
    if (removedAncestor) continue;
    const recursive = path.endsWith("/");
    updates.push({ type: "remove", path, ...(recursive ? { recursive: true } : {}) });
    if (recursive) removedDirectoryRoots.add(path);
  }

  const addedPaths = nextPaths
    .filter((path) => !previous.has(path))
    .toSorted((left, right) => pathDepth(left) - pathDepth(right));
  for (const path of addedPaths) updates.push({ type: "add", path });

  return updates;
}
