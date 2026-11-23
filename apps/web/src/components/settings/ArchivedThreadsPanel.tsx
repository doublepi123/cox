import type { ContextMenuSource } from "@t3tools/contracts";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useTranslation } from "../../i18n";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { observeIntersection } from "~/lib/observeIntersection";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { settingsScopeEnvironmentLabels } from "./settingsScopeAxis";
import { Spinner } from "~/components/ui/spinner";
import { ArchiveIcon, ArchiveX, Trash2Icon } from "lucide-react";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useSettingsScope } from "./SettingsScopeContext";
import { useThreadActions } from "../../hooks/useThreadActions";
import { readLocalApi } from "../../localApi";
import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { ProjectFavicon } from "../ProjectFavicon";

const ARCHIVED_ROW_CHUNK_SIZE = 50;
const ESTIMATED_ARCHIVED_ROW_PX = 67;

// Thousands of archived threads would mount at once, so each chunk of rows mounts only near the
// visible part of the settings scroller and otherwise keeps its last measured height.
function ArchivedThreadChunk(props: {
  readonly rowCount: number;
  readonly initiallyMounted: boolean;
  readonly renderRows: () => ReactNode;
}) {
  const { rowCount } = props;
  const [view, setView] = useState({
    near: props.initiallyMounted,
    rowHeight: ESTIMATED_ARCHIVED_ROW_PX,
  });
  const observeChunk = useCallback(
    (node: HTMLDivElement | null) => {
      if (!node) return;
      return observeIntersection(
        node,
        (entry) =>
          setView({
            near: entry.isIntersecting,
            rowHeight: entry.boundingClientRect.height / rowCount,
          }),
        { root: node.closest("[data-settings-page-scroll]"), rootMargin: "1200px 0px" },
      );
    },
    [rowCount],
  );
  return (
    <div
      ref={observeChunk}
      className="*:not-first:border-t *:not-first:border-border/50"
      style={view.near ? undefined : { height: view.rowHeight * rowCount }}
    >
      {view.near ? props.renderRows() : null}
    </div>
  );
}

export function ArchivedThreadsPanel() {
  const { t } = useTranslation();
  const { scope, groups: projectGroups, environments } = useSettingsScope();
  const { unarchiveThread, confirmAndDeleteThread } = useThreadActions();
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const deletingRef = useRef(false);
  const {
    snapshots: archivedSnapshots,
    error: archiveError,
    isLoading: isLoadingArchive,
    refresh: refreshArchivedThreads,
  } = useArchivedThreadSnapshots(scope.environmentIds);

  const { groups: archivedGroups, hasMultipleEnvironments } = (() => {
    const selectedProjectKeys =
      scope.kind === "project" || scope.kind === "checkout"
        ? new Set(scope.members.map((member) => `${member.environmentId}:${member.id}`))
        : null;
    const projectsByEnvironmentAndId = new Map(
      archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
        snapshot.projects
          .filter(
            (project) =>
              selectedProjectKeys === null ||
              selectedProjectKeys.has(`${environmentId}:${project.id}`),
          )
          .map(
            (project) => [`${environmentId}:${project.id}`, { ...project, environmentId }] as const,
          ),
      ),
    );
    const environmentLabels = new Map(
      environments.map((environment) => {
        const { primary, secondary } = settingsScopeEnvironmentLabels(environment, environments);
        return [environment.environmentId, secondary ? `${primary} (${secondary})` : primary];
      }),
    );
    const threads = archivedSnapshots.flatMap(({ environmentId, snapshot }) =>
      snapshot.threads.map((thread) => ({
        ...presentThreadShell(environmentId, thread),
        environmentLabel: environmentLabels.get(environmentId) ?? environmentId,
      })),
    );
    const hasMultipleEnvironments =
      new Set(
        threads
          .filter((thread) =>
            projectsByEnvironmentAndId.has(`${thread.environmentId}:${thread.projectId}`),
          )
          .map((thread) => thread.environmentId),
      ).size > 1;
    const logicalGroupsByProjectKey = new Map(
      projectGroups.flatMap((group) =>
        group.memberProjectRefs.map(
          (member) => [`${member.environmentId}:${member.projectId}`, group] as const,
        ),
      ),
    );

    const archivedProjects = Array.from(projectsByEnvironmentAndId.values());
    const groups = new Map<
      string,
      {
        readonly project: (typeof archivedProjects)[number];
        readonly title: string;
        readonly threads: Array<(typeof threads)[number]>;
      }
    >();
    for (const project of archivedProjects) {
      const projectThreads: Array<(typeof threads)[number]> = [];
      for (const thread of threads) {
        if (thread.projectId === project.id && thread.environmentId === project.environmentId) {
          projectThreads.push(thread);
        }
      }
      if (projectThreads.length > 0) {
        const physicalProjectKey = `${project.environmentId}:${project.id}` as const;
        const logicalGroup = hasMultipleEnvironments
          ? logicalGroupsByProjectKey.get(physicalProjectKey)
          : undefined;
        const groupKey = logicalGroup?.projectKey ?? physicalProjectKey;
        const group = groups.get(groupKey);
        if (group) {
          group.threads.push(...projectThreads);
        } else {
          groups.set(groupKey, {
            project,
            title: logicalGroup?.displayName ?? project.title,
            threads: projectThreads,
          });
        }
      }
    }
    let firstRow = 0;
    const sortedGroups = Array.from(groups, ([key, group]) => {
      const sorted = {
        ...group,
        key,
        firstRow,
        threads: group.threads.toSorted((left, right) => {
          const leftKey = left.archivedAt ?? left.createdAt;
          const rightKey = right.archivedAt ?? right.createdAt;
          return rightKey.localeCompare(leftKey) || right.id.localeCompare(left.id);
        }),
      };
      firstRow += group.threads.length;
      return sorted;
    });
    return { groups: sortedGroups, hasMultipleEnvironments };
  })();

  const deleteArchivedThread = async (threadRef: ScopedThreadRef, title?: string) => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeletingKey(scopedThreadKey(threadRef));
    const result = await confirmAndDeleteThread(threadRef, title).finally(() => {
      deletingRef.current = false;
      setDeletingKey(null);
    });
    if (result._tag === "Success") refreshArchivedThreads();
    else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: t("Failed to delete thread"),
          description: error instanceof Error ? error.message : t("An error occurred."),
        }),
      );
    }
  };

  const handleArchivedThreadContextMenu = async (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
    source: ContextMenuSource,
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await api.contextMenu.show(
      [
        { id: "unarchive", label: t("Unarchive") },
        { id: "delete", label: t("Delete"), destructive: true },
      ],
      position,
      source,
    );

    if (clicked === "unarchive") {
      const result = await unarchiveThread(threadRef);
      if (result._tag === "Success") {
        refreshArchivedThreads();
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: t("Failed to unarchive thread"),
            description: error instanceof Error ? error.message : t("An error occurred."),
          }),
        );
      }
      return;
    }

    if (clicked === "delete") {
      await deleteArchivedThread(threadRef);
    }
  };

  return (
    <SettingsPageContainer>
      {archivedGroups.length === 0 ? (
        <SettingsSection
          id={isLoadingArchive ? undefined : searchableSetting("archive").id}
          title={t(searchableSetting("archive").title)}
        >
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                {isLoadingArchive ? (
                  <Spinner size="sm" tone="muted" />
                ) : (
                  <ArchiveIcon className="size-3.5 text-muted-foreground" />
                )}
                {isLoadingArchive
                  ? t("Loading archived threads")
                  : archiveError
                    ? t("Could not load archived threads")
                    : t("No archived threads")}
              </span>
            }
            description={
              isLoadingArchive
                ? t("Checking connected environments.")
                : (archiveError ?? t("Archived threads will appear here."))
            }
          />
        </SettingsSection>
      ) : (
        archivedGroups.map(({ key, project, title, firstRow, threads: projectThreads }, index) => (
          <SettingsSection
            key={key}
            id={index === 0 ? searchableSetting("archive").id : undefined}
            title={title}
            icon={<ProjectFavicon project={project} />}
          >
            {Array.from(
              { length: Math.ceil(projectThreads.length / ARCHIVED_ROW_CHUNK_SIZE) },
              (_, chunkIndex) => {
                const start = chunkIndex * ARCHIVED_ROW_CHUNK_SIZE;
                const rows = projectThreads.slice(start, start + ARCHIVED_ROW_CHUNK_SIZE);
                return (
                  <ArchivedThreadChunk
                    key={chunkIndex}
                    rowCount={rows.length}
                    initiallyMounted={firstRow + start < ARCHIVED_ROW_CHUNK_SIZE}
                    renderRows={() =>
                      rows.map((thread) => (
                        <SettingsRow
                          className="rounded-none"
                          key={`${thread.environmentId}:${thread.id}`}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            void (async () => {
                              const result = await settlePromise(() =>
                                handleArchivedThreadContextMenu(
                                  scopeThreadRef(thread.environmentId, thread.id),
                                  {
                                    x: event.clientX,
                                    y: event.clientY,
                                  },
                                  contextMenuSourceOf(event),
                                ),
                              );
                              if (result._tag === "Failure") {
                                const error = squashAtomCommandFailure(result);
                                toastManager.add(
                                  stackedThreadToast({
                                    type: "error",
                                    title: t("Archived thread action failed"),
                                    description:
                                      error instanceof Error ? error.message : "An error occurred.",
                                  }),
                                );
                              }
                            })();
                          }}
                          title={thread.title}
                          description={
                            <span
                              className={hasMultipleEnvironments ? "block truncate" : undefined}
                            >
                              {hasMultipleEnvironments ? `${thread.environmentLabel} · ` : null}
                              {t("Archived")}{" "}
                              <RelativeTime timestamp={thread.archivedAt ?? thread.createdAt} />
                              {t(" · Created ")}
                              <RelativeTime timestamp={thread.createdAt} />
                            </span>
                          }
                          control={
                            <div className="flex flex-wrap gap-2">
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                  void (async () => {
                                    const result = await unarchiveThread(
                                      scopeThreadRef(thread.environmentId, thread.id),
                                    );
                                    if (result._tag === "Success") {
                                      refreshArchivedThreads();
                                      return;
                                    }
                                    if (!isAtomCommandInterrupted(result)) {
                                      const error = squashAtomCommandFailure(result);
                                      toastManager.add(
                                        stackedThreadToast({
                                          type: "error",
                                          title: "Failed to unarchive thread",
                                          description:
                                            error instanceof Error
                                              ? error.message
                                              : "An error occurred.",
                                        }),
                                      );
                                    }
                                  })();
                                }}
                              >
                                <ArchiveX className="size-3.5" />
                                <span>{t("Unarchive")}</span>
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost-muted"
                                disabled={deletingKey !== null}
                                onClick={() =>
                                  void deleteArchivedThread(
                                    scopeThreadRef(thread.environmentId, thread.id),
                                    thread.title,
                                  )
                                }
                              >
                                <Trash2Icon className="size-3.5" />
                                {t("Delete")}
                              </Button>
                            </div>
                          }
                        />
                      ))
                    }
                  />
                );
              },
            )}
          </SettingsSection>
        ))
      )}
    </SettingsPageContainer>
  );
}
