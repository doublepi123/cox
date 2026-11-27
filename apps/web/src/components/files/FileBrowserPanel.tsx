import { SharedTooltipTrigger } from "~/components/ui/shared-tooltip";
import { useFileDownload } from "./useFileDownload";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { isMacPlatform } from "~/lib/utils";
import { useTranslation } from "../../i18n";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { ContextMenuSource, EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { MorphIcon } from "~/components/MorphIcon";
import { toastManager } from "~/components/ui/toast";

import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import {
  PIERRE_TREE_UNSAFE_CSS,
  pierreTreeStyle,
  titleClippedPierreTreeRow,
} from "~/pierre-tree-theme";

import { joinHostPath } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import {
  areAllDirectoriesExpanded,
  onlyChildren,
  readExpandedDirectories,
  setAllDirectoriesExpanded,
  writeExpandedDirectories,
} from "./fileTreeExpansion";
import { buildFileTreePathUpdates, shouldRebuildFileTree } from "./fileTreePathReconciliation";
import { loadFileAncestors } from "./loadFileAncestors";
import { useDirectoryEntries } from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <SharedTooltipTrigger
      render={
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Refresh workspace files"
          onClick={props.onRefresh}
        />
      }
      label={props.isPending ? "Refreshing…" : "Refresh files"}
    >
      <RefreshIcon refreshing={props.isPending} />
    </SharedTooltipTrigger>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <div className="min-w-0 h-7 flex-1">
      <InputGroup variant="ghost">
        <InputGroupInput
          type="text"
          role="searchbox"
          name={props.name}
          size="sm"
          value={props.value}
          aria-label={props.ariaLabel}
          placeholder="Search files"
          data-workspace-focus-default
          spellCheck={false}
          onChange={(event) => props.onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229)
              return;
            if (props.value || event.repeat) {
              event.preventDefault();
              event.stopPropagation();
              if (props.value) props.onClose();
              return;
            }
            props.onClose();
            event.currentTarget.blur();
          }}
        />
      </InputGroup>
    </div>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const entryKinds: ReadonlyMap<string, ProjectEntry["kind"]> = new Map(
    entries.map((entry) => [entry.path, entry.kind] as const),
  );
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths };
}

// A symlink to its own parent lists itself as an only child without end.
const MAX_FOLDERS_OPENED_WITH_PARENT = 16;

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
}: FileBrowserPanelProps) {
  const { t } = useTranslation();
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const downloadFile = useFileDownload(environmentId);
  const {
    entries: directoryEntries,
    load,
    refresh,
    revalidate,
    ready,
    error,
    isPending,
    loadingDirectories,
  } = useDirectoryEntries(environmentId, cwd);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
  );
  const { entries, entryKinds, treePaths, directoryPaths, expandableDirectoryPaths } =
    buildTreeEntries(directoryEntries, pathSearch.entries, pathSearch.isPending, query);
  const entryKindsRef = useRef(entryKinds);
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);
  const followedRevealRef = useRef<string | null>(null);

  // Shadow-DOM row rects are unreliable; capture the composed contextmenu event's viewport position.
  const contextMenuPointerRef = useRef<{
    x: number;
    y: number;
    at: number;
    source: ContextMenuSource;
  } | null>(null);

  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      // The app menu owns focus; the tree's outside-click handler would dismiss it before click.
      context.close({ restoreFocus: !pointerIsFresh });
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            ...(downloadFile && item.kind !== "directory"
              ? [{ id: "download", label: t("Download") }]
              : []),
            { id: "copy-path", label: t("Copy path") },
            { id: "copy-mention", label: "Copy mention" },
            { id: "add-to-chat", label: "Add to chat" },
          ],
          position,
          pointerIsFresh ? pointer.source : undefined,
        );
        if (clicked === null) return;
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "download") {
          downloadFile?.(cwd, relativePath);
          return;
        }
        if (clicked === "copy-path" || clicked === "copy-mention") {
          const copyingPath = clicked === "copy-path";
          try {
            await writeTextToClipboard(copyingPath ? joinHostPath(cwd, relativePath) : mention);
            if (!copyingPath) {
              toastManager.add({
                type: "success",
                title: "Mention copied",
                description: relativePath,
              });
            }
          } catch (error) {
            toastManager.add({
              type: "error",
              title: copyingPath ? t("Failed to copy path") : "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }).then((result) => {
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const loadingDirectoriesRef = useRef(loadingDirectories);
  const revalidateDirectory = useStableCallback(revalidate);
  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) === "file") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) => {
      const path = item.path.replace(/\/$/, "");
      const open = row.kind === "directory" && row.isExpanded;
      // Pierre calls this for the rows it renders, which is the only sign of what is on screen.
      revalidateDirectory(open ? path : path.slice(0, Math.max(0, path.lastIndexOf("/"))));
      return open && loadingDirectoriesRef.current.has(path)
        ? { icon: "t3-tree-icon-loading", title: t("Loading…") }
        : null;
    },
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when loading directories change
  useEffect(() => {
    if (loadingDirectoriesRef.current === loadingDirectories) return;
    loadingDirectoriesRef.current = loadingDirectories;
    model.setComposition(model.getComposition());
  }, [loadingDirectories, model]);
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  const expandedPathsRef = useRef(new Set<string>());
  const openingPathsRef = useRef(new Map<string, number>());
  const expansionRoot = `${environmentId}:${cwd}`;
  const [pendingExpandedPaths] = useState(() => new Set(readExpandedDirectories(expansionRoot)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the Pierre tree model to load directories as they are expanded
  useEffect(() => {
    const currentPaths = new Set(directoryPaths);
    const expandedPaths = expandedPathsRef.current;
    for (const path of expandedPaths) {
      if (!currentPaths.has(path)) expandedPaths.delete(path);
    }
    const openingPaths = openingPathsRef.current;
    for (const path of openingPaths.keys()) {
      if (!currentPaths.has(path)) openingPaths.delete(path);
    }
    let childrenByParent: ReturnType<typeof onlyChildren> | undefined;
    let restoring = false;
    const loadExpanded = () => {
      if (restoring || model.isSearchOpen()) return;
      let changed = false;
      for (const path of directoryPaths) {
        const item = model.getItem(path);
        if (!item?.isDirectory() || !("isExpanded" in item)) continue;
        const restored = pendingExpandedPaths.delete(path);
        if ("expand" in item && restored && !item.isExpanded()) {
          restoring = true;
          item.expand();
          restoring = false;
        }
        if (item.isExpanded()) {
          if (!expandedPaths.has(path)) {
            expandedPaths.add(path);
            changed = true;
            if (!restored && !openingPaths.has(path))
              openingPaths.set(path, MAX_FOLDERS_OPENED_WITH_PARENT);
            void load(path.replace(/\/$/, ""));
          }
          const remaining = openingPaths.get(path);
          if (remaining === undefined) continue;
          if (childrenByParent === undefined) childrenByParent = onlyChildren(directoryEntries);
          const child = childrenByParent.get(path.replace(/\/$/, ""));
          if (child === undefined) continue;
          if (
            remaining === 0 ||
            child?.kind !== "directory" ||
            (child.ignored &&
              !directoryEntries.some((entry) => entry.ignored && treePath(entry) === path))
          ) {
            openingPaths.delete(path);
            continue;
          }
          const childPath = treePath(child);
          const childItem = model.getItem(childPath);
          if (!childItem || !("expand" in childItem)) continue;
          openingPaths.delete(path);
          if (!childItem.isExpanded()) {
            openingPaths.set(childPath, remaining - 1);
            restoring = true;
            childItem.expand();
            restoring = false;
          }
        } else {
          openingPaths.delete(path);
          if (expandedPaths.delete(path)) {
            changed = true;
            setExpandAll(false);
          }
        }
      }
      if (changed) {
        writeExpandedDirectories(expansionRoot, [...expandedPaths, ...pendingExpandedPaths]);
      }
    };
    loadExpanded();
    return model.subscribe(loadExpanded);
  }, [directoryEntries, directoryPaths, expansionRoot, load, model, pendingExpandedPaths]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes ignored-file status into the imperative Pierre tree model
  useEffect(() => {
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({
          path: treePath(entry),
          status: "ignored",
        })),
    );
  }, [entries, model]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the selected file's ancestor directories and aborts on cleanup
  useEffect(() => {
    if (!selectedPath) return;
    const controller = new AbortController();
    void loadFileAncestors(selectedPath, load, { signal: controller.signal });
    return () => {
      controller.abort();
    };
  }, [load, selectedPath]);
  const stopFollowingReveal = () => {
    followedRevealRef.current = null;
  };
  const handleSearchValueChange = (value: string) => {
    stopFollowingReveal();
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const refreshDirectories = () => {
    refresh();
    model.setComposition(model.getComposition());
  };
  const handleRefresh = () => {
    refreshDirectories();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: () => {
      refreshDirectories();
      if (query.trim()) pathSearch.refresh();
    },
    resourceKey: `files:${environmentId}:${cwd}`,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies tree path changes to the imperative Pierre tree model as a reset or batch update
  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    entryKindsRef.current = entryKinds;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
      return;
    }
    const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
    if (updates.length === 0) return;
    if (shouldRebuildFileTree(previousTreePaths, treePaths, updates)) {
      const activeSearch = model.isSearchOpen() ? model.getSearchValue() : null;
      if (activeSearch !== null) model.closeSearch();
      model.resetPaths(treePaths, { initialExpandedPaths: [...expandedPathsRef.current] });
      if (activeSearch !== null) model.setSearch(activeSearch);
    } else {
      model.batch(updates);
    }
    if (followedRevealRef.current !== null) {
      model.scrollToPath(followedRevealRef.current, { focus: false, offset: "center" });
    }
  }, [ready, entryKinds, model, treePaths]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands every directory in the Pierre tree model while expand-all is on and no search is active
  useEffect(() => {
    if (expandAll && !query.trim())
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
  }, [expandableDirectoryPaths, expandAll, model, query]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reveals an externally selected path in the Pierre tree model by expanding, selecting and scrolling
  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      followedRevealRef.current = null;
      return;
    }
    const selectedKind = entryKinds.get(selectedPath);
    if (selectedKind === undefined) {
      handledRevealRef.current = null;
      followedRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    const handledReveal = handledRevealRef.current;
    // Refresh rebuilds treePaths; replaying handled reveals would close search and steal focus.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    const selectedTreePath = selectedKind === "directory" ? `${selectedPath}/` : selectedPath;
    const selectedItem = model.getItem(selectedTreePath);
    if (!selectedItem) return;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((path) => path.replace(/\/$/, "") === selectedPath);
    if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;
      followedRevealRef.current = null;
      return;
    }
    treeSelectionPathRef.current = null;
    handledRevealRef.current = revealRequest;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const path of model.getSelectedPaths()) {
      model.getItem(path)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = selectedPath.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    followedRevealRef.current = selectedTreePath;
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [entryKinds, model, selectedPath, selectedPathRevealId]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      // Capture runs before the tree's shadow-internal row handler opens the menu.
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = {
          x: event.clientX,
          y: event.clientY,
          at: event.timeStamp,
          source: contextMenuSourceOf(event),
        };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
      onWheel={stopFollowingReveal}
      onPointerDown={stopFollowingReveal}
      onTouchStart={stopFollowingReveal}
      onKeyDown={(event) => {
        stopFollowingReveal();
        const modifier = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
        if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "f") return;
        const searchInput = event.currentTarget.querySelector<HTMLInputElement>(
          'input[name="project-files-search"]',
        );
        if (!searchInput) return;
        event.preventDefault();
        searchInput.focus();
        searchInput.select();
      }}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {directoryPaths.length > 0 && !hostFolder ? (
          <SharedTooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={
                  expandAll || allDirectoriesExpanded
                    ? "Collapse all folders"
                    : "Expand all folders"
                }
                onClick={toggleAllDirectories}
              />
            }
            label={
              <>
                {expandAll || allDirectoriesExpanded
                  ? "Collapse all folders"
                  : "Expand all folders"}
              </>
            }
          >
            <MorphIcon
              className="size-3.5"
              icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
            />
          </SharedTooltipTrigger>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          Loading files…
        </div>
      )}
      {hasNoSearchMatches ? (
        ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            No matching files.
          </div>
        ) : null
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          onClickCapture={(event) => {
            if (
              event.defaultPrevented ||
              event.button !== 0 ||
              event.ctrlKey ||
              event.metaKey ||
              event.shiftKey ||
              event.altKey ||
              dragMention.isDragInProgress()
            ) {
              return;
            }
            // Pierre emits no change for its sole selected row; read before the click to avoid double opens.
            const selected = model.getSelectedPaths();
            const path = selected.length === 1 ? selected[0] : undefined;
            if (!path || entryKindsRef.current.get(path) !== "file") return;
            const clickedSelectedRow = event.nativeEvent
              .composedPath()
              .some(
                (node) =>
                  node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
              );
            if (!clickedSelectedRow) return;
            treeSelectionPathRef.current = path;
            onOpenFile(panelPath(path));
          }}
          style={pierreTreeStyle(resolvedTheme)}
          onPointerOver={titleClippedPierreTreeRow}
        />
      )}
    </div>
  );
}
