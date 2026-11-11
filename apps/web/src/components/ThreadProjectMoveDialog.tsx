import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useRef, useState } from "react";
import { create } from "zustand";

import { useTranslation } from "../i18n";
import { readThreadShell, useProjects, useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { ProjectFavicon } from "./ProjectFavicon";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { toastManager } from "./ui/toast";

interface MoveRequest {
  readonly threadRef: ScopedThreadRef;
  readonly sourceProjectId: ProjectId;
}

const useMoveRequest = create<{ readonly request: MoveRequest | null }>(() => ({ request: null }));

export function openThreadProjectMoveDialog(threadRef: ScopedThreadRef): void {
  const thread = readThreadShell(threadRef);
  if (thread === null) return;
  useMoveRequest.setState({
    request: { threadRef, sourceProjectId: thread.projectId },
  });
}

export function ThreadProjectMoveDialogHost() {
  const request = useMoveRequest((state) => state.request);
  const thread = useThreadShell(request?.threadRef ?? null);
  if (request === null || thread === null) return null;
  return (
    <ThreadProjectMoveDialog
      key={`${request.threadRef.environmentId}:${request.threadRef.threadId}:${request.sourceProjectId}`}
      request={request}
      threadTitle={thread.title}
    />
  );
}

function ThreadProjectMoveDialog(props: {
  readonly request: MoveRequest;
  readonly threadTitle: string;
}) {
  const { t } = useTranslation();
  const projects = useProjects();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moveToProject = useOrchestrationCommand(threadEnvironment.moveToProject, {
    reportFailure: false,
  });
  const close = () => useMoveRequest.setState({ request: null });
  const candidates = projects
    .filter(
      (project) =>
        project.environmentId === props.request.threadRef.environmentId &&
        project.id !== props.request.sourceProjectId &&
        !project.isScratch,
    )
    .toSorted((left, right) => left.title.localeCompare(right.title));
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleProjects = candidates.filter((project) =>
    normalizedQuery.length === 0
      ? true
      : `${project.title}\n${project.workspaceRoot}`.toLocaleLowerCase().includes(normalizedQuery),
  );

  const selectProject = async (project: EnvironmentProject) => {
    setPending(true);
    setError(null);
    const result = await moveToProject({
      environmentId: props.request.threadRef.environmentId,
      input: {
        threadId: props.request.threadRef.threadId,
        projectId: project.id,
        expectedProjectId: props.request.sourceProjectId,
      },
    });
    if (result._tag === "Failure") {
      setPending(false);
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : t("Failed to move thread"));
      }
      return;
    }
    toastManager.add({
      type: "success",
      title: t("Thread moved"),
      description: project.title,
    });
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogPopup width="md" initialFocus={inputRef}>
        <DialogHeader>
          <DialogTitle>{t("Move thread to project")}</DialogTitle>
          <DialogDescription>
            {t(
              "Only conversation content is moved. Code and uncommitted changes stay in the original project; future work uses the target project.",
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex min-h-0 flex-col gap-3">
          <Input
            ref={inputRef}
            aria-label={t("Search projects")}
            placeholder={t("Search projects...")}
            value={query}
            disabled={pending}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="max-h-80 min-h-20 overflow-y-auto" aria-label={props.threadTitle}>
            {visibleProjects.map((project) => (
              <Button
                key={project.id}
                variant="ghost"
                size="multiline"
                align="start"
                fill
                aria-label={`${project.title} ${project.workspaceRoot}`}
                disabled={pending}
                onClick={() => void selectProject(project)}
              >
                <ProjectFavicon project={project} className="size-5 shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{project.title}</span>
                  <span className="block truncate text-muted-foreground text-xs font-normal">
                    {project.workspaceRoot}
                  </span>
                </span>
              </Button>
            ))}
            {visibleProjects.length === 0 ? (
              <p className="px-3 py-8 text-center text-muted-foreground text-sm">
                {candidates.length === 0
                  ? t("No other projects are available.")
                  : t("No matching projects.")}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={pending} onClick={close}>
            {t("Cancel")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
