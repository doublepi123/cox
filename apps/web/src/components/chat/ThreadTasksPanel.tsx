import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CircleCheckIcon, CircleDotIcon, CircleIcon } from "lucide-react";

import { useTranslation } from "../../i18n";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { deriveCurrentTodoList } from "./threadTasks";

const TASK_STATUS = {
  completed: {
    Icon: CircleCheckIcon,
    label: "Task completed",
    iconClassName: "text-success",
    textClassName: "text-muted-foreground",
  },
  running: {
    Icon: CircleDotIcon,
    label: "Task in progress",
    iconClassName: "text-info",
    textClassName: "font-medium text-foreground",
  },
  pending: {
    Icon: CircleIcon,
    label: "Task pending",
    iconClassName: "text-muted-foreground/60",
    textClassName: "text-foreground/80",
  },
} as const;

export function ThreadTasksPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { t } = useTranslation();
  const thread = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const todoList = thread ? deriveCurrentTodoList(thread.projection) : null;
  if (todoList === null) return null;
  const completed = todoList.steps.filter((step) => step.status === "completed").length;
  const total = todoList.steps.length;
  return (
    <ThreadDetailsSection
      headingId={`thread-details-tasks-${props.threadId}`}
      title={t("Tasks")}
      data-thread-tasks-panel
      actions={
        <span
          className="rounded-full bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
          aria-label={t("{completed} of {total} tasks completed", { completed, total })}
        >
          {completed}/{total}
        </span>
      }
    >
      <ol className="max-h-64 min-w-0 overflow-y-auto overscroll-contain px-2.5">
        {todoList.steps.map((step) => {
          const status = TASK_STATUS[step.status];
          return (
            <li
              key={step.id}
              data-task-status={step.status}
              className="flex min-w-0 items-start gap-2 py-1 text-xs leading-4"
            >
              <status.Icon aria-hidden className={cn("size-4 shrink-0", status.iconClassName)} />
              <span className={cn("min-w-0 flex-1 break-words", status.textClassName)}>
                <span className="sr-only">{t(status.label)}</span> {step.text}
              </span>
            </li>
          );
        })}
      </ol>
    </ThreadDetailsSection>
  );
}
