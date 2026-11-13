import type {
  OrchestrationV2ProviderSession,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
  type RunStopPresentation,
} from "@t3tools/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@t3tools/client-runtime/state/threads";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import * as DateTime from "effect/DateTime";
import {
  ChevronDownIcon,
  CircleDashedIcon,
  CircleStopIcon,
  GitBranchIcon,
  LoaderCircleIcon,
  MessageCircleIcon,
  ShieldQuestionIcon,
  TargetIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Fragment } from "react";
import { useTranslation } from "../../i18n";
import { tickTextContent } from "~/lib/tickTextContent";
import { cn } from "~/lib/utils";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

type ExtensionStatuses = NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>;

type MemoryStatusText = "Memory reflecting" | "Memory sync blocked" | "Memory sync held";

export type VisibleExtensionStatus =
  | { readonly kind: "memory"; readonly key: string; readonly text: MemoryStatusText }
  | { readonly kind: "raw"; readonly key: string; readonly text: string };

function memoryStatusText(text: string): MemoryStatusText | null {
  if (text.includes("reflecting")) return "Memory reflecting";
  if (text.includes(" sync blocked")) return "Memory sync blocked";
  if (text.includes(" sync held")) return "Memory sync held";
  return null;
}

export function visibleExtensionStatuses(
  statuses: ExtensionStatuses,
): ReadonlyArray<VisibleExtensionStatus> {
  return statuses.flatMap((status): ReadonlyArray<VisibleExtensionStatus> => {
    if (status.key.trim() === "omo-native") return [];
    if (status.key !== "memory") return [{ kind: "raw", key: status.key, text: status.text }];
    const text = memoryStatusText(status.text);
    return text === null ? [] : [{ kind: "memory", key: status.key, text }];
  });
}

function ExtensionStatusDisclosure({
  statuses,
  providerLabel,
}: {
  readonly statuses: ReadonlyArray<VisibleExtensionStatus>;
  readonly providerLabel: string;
}) {
  const { t: translateUi } = useTranslation();
  const label = translateUi("{provider} extension status", { provider: providerLabel });
  const texts = statuses.map((status) =>
    status.kind === "memory" ? translateUi(status.text) : status.text,
  );
  const summaryIndex = Math.max(
    0,
    statuses.findIndex((status) => status.key === "goal-wait"),
  );
  const reflecting = statuses.some(
    (status) => status.kind === "memory" && status.text === "Memory reflecting",
  );
  return (
    <Popover>
      <PopoverTrigger
        render={<ComposerBanner.Row render={<button type="button" />} />}
        aria-label={label}
        className="pe-2 sm:pe-1.5"
      >
        <ComposerBanner.Icon>
          {reflecting ? (
            <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
          ) : (
            <CircleDashedIcon />
          )}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="leading-7 sm:leading-6">
          <span className="min-w-0 flex-1 whitespace-normal break-words font-medium">
            {texts[summaryIndex]}
          </span>
          {texts.length > 1 ? (
            <span className="flex-none text-muted-foreground tabular-nums">
              +{texts.length - 1}
            </span>
          ) : null}
          <ChevronDownIcon className="size-3 flex-none text-muted-foreground transition-transform duration-150 group-data-popup-open/banner-row:rotate-180 motion-reduce:transition-none" />
        </ComposerBanner.Content>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" presentation="banner" padding="compact" touchBackdrop>
        <div className="grid gap-2">
          <PopoverTitle>{label}</PopoverTitle>
          <ComposerBanner.Scroll className="max-h-[min(var(--available-height),24rem,40dvh)]">
            <ul className="grid gap-1 text-xs break-words select-text">
              {statuses.map((status, index) => (
                <li key={status.key}>{texts[index]}</li>
              ))}
            </ul>
          </ComposerBanner.Scroll>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export function extensionStatusBannerItem(
  statuses: ExtensionStatuses,
  providerLabel = "Pi",
): ComposerBannerStackItem | null {
  const visible = visibleExtensionStatuses(statuses);
  if (visible.length === 0) return null;
  return {
    id: "provider-extension-status",
    width: "fill",
    variant: "default",
    icon: <CircleDashedIcon />,
    title: providerLabel,
    row: <ExtensionStatusDisclosure statuses={visible} providerLabel={providerLabel} />,
  };
}

/** Subagents and side chats waiting on the user, unless the parent is itself waiting on them. */
export function childInputNowItem(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  readonly parentAwaitingUser: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): (ThreadNowItem & { readonly waitingLabel: string }) | null {
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    // The only line at the end of the timeline that needs you gets the info color.
    icon: first.hasPendingApprovals ? (
      <ShieldQuestionIcon className="text-info-foreground" />
    ) : (
      <MessageCircleIcon className="text-info-foreground" />
    ),
    title: childThreadInputsTitle(childThreadInputs),
    waitingLabel: childThreadInputs.every((child) => child.lineage.sideChat === true)
      ? "Side chat waiting"
      : "Subagent waiting",
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton tone="muted" onClick={() => onOpenThread(child.id)}>
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <InlineButton onClick={() => onOpenThread(first.id)}>
        {first.hasPendingApprovals ? "Open approval" : "Open question"}
      </InlineButton>
    ),
  };
}

/** The thread's goal, for the end of the timeline. */
export function goalNowItem(input: {
  readonly threadId: ThreadId;
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isWorking: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
}): ThreadNowItem {
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking);
  return {
    id: `goal:${input.threadId}`,
    icon: <TargetIcon />,
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <>
            <InlineButton
              onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}
            >
              Resume
            </InlineButton>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <InlineButton
          tone="muted"
          onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
        >
          Clear
        </InlineButton>
      </>
    ),
  };
}

/** A Stop the provider has not finished; Force stop once it stops answering. */
export function runStopNowItem(input: {
  readonly threadId: ThreadId;
  readonly stop: RunStopPresentation;
  readonly canForceStop: boolean;
  readonly forceStopping: boolean;
  readonly onForceStop: () => void;
}): ThreadNowItem {
  const unresponsive = input.stop.state === "unresponsive";
  const requestedAtMs = Date.parse(input.stop.requestedAt);
  return {
    id: `run-stop:${input.threadId}`,
    icon: unresponsive ? (
      <TriangleAlertIcon className="text-warning-foreground" />
    ) : (
      <CircleStopIcon />
    ),
    title: unresponsive ? "Agent not responding to Stop" : "Stopping",
    description: unresponsive
      ? "It may be short on memory. Force stop kills its processes."
      : undefined,
    actions: (
      <>
        <span
          ref={tickTextContent(
            (nowMs) => formatDuration(Math.max(1_000, nowMs - requestedAtMs)),
            true,
          )}
          className="tabular-nums"
        />
        {unresponsive && input.canForceStop ? (
          <InlineButton disabled={input.forceStopping} onClick={input.onForceStop}>
            {input.forceStopping ? "Force stopping..." : "Force stop"}
          </InlineButton>
        ) : null}
      </>
    ),
  };
}

/** Background commands and subagents, for the end of the timeline. */
export function backgroundWorkNowItem(input: {
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { onOpenThread } = input;
  const presentation = presentPendingBackgroundWork(input.tasks);
  if (presentation === null) return null;
  const rows = presentation.items.map((task) => {
    // Same key derivePendingBackgroundWork gives turn-item tasks; subagent items carry progress.
    const item = input.turnItems.findLast(
      (candidate) => (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId,
    );
    const subagent = item?.type === "subagent" ? item : undefined;
    return {
      task,
      activity: subagent?.progress?.replace(/\s+/gu, " ").trim() || null,
      startedAtMs: item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null,
      updatedAtMs: subagent ? DateTime.toEpochMillis(subagent.updatedAt) : 0,
      childThreadId: task.childThreadId ?? subagent?.childThreadId ?? undefined,
    };
  });
  const [only] = rows.length === 1 ? rows : [];
  const newest = rows
    .filter((row) => row.activity)
    .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const isCommand = (row: (typeof rows)[number]) => row.task.kind !== "subagent";
  const verb = presentation.waiting ? "Waiting on" : "Running";
  const onlyThreadId = only?.childThreadId;
  const startedAtMs = only?.startedAtMs ?? null;
  return {
    id: `background-work:${input.threadId}`,
    icon: rows.every(isCommand) ? <TerminalIcon /> : <CircleDashedIcon />,
    title: only ? (
      <>
        {verb} <span className={cn(isCommand(only) && "font-mono")}>{only.task.label}</span>
      </>
    ) : (
      presentation.title
    ),
    description: only ? (
      only.activity
    ) : newest ? (
      `${newest.task.label}: ${newest.activity}`
    ) : rows.every(isCommand) ? (
      <span className="font-mono">{rows.map((row) => row.task.label).join(", ")}</span>
    ) : (
      rows.map((row) => row.task.label).join(", ")
    ),
    actions: (
      <>
        {startedAtMs === null ? null : (
          <span
            ref={tickTextContent(
              (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)),
              true,
            )}
            className="tabular-nums"
          />
        )}
        {onlyThreadId === undefined ? null : (
          <InlineButton tone="muted" onClick={() => onOpenThread(onlyThreadId)}>
            Open
          </InlineButton>
        )}
        <InlineButton disabled={input.stopDisabled} onClick={() => void input.onStop()}>
          {input.stopping ? "Stopping..." : "Stop"}
        </InlineButton>
      </>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(input: {
  readonly mismatchKey: string;
  readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
  readonly restoreDisabled: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { mismatch } = input;
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-normal text-muted-foreground">Branch changed from</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 truncate font-medium text-foreground">
                {mismatch.threadBranch}
              </code>
            }
          />
          <TooltipPopup side="top">
            This thread last ran on {mismatch.threadBranch}. Sending will continue on{" "}
            {mismatch.currentBranch}.
          </TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? "Restoring..." : "Restore branch"}
      </Button>
    ),
    dismissLabel: "Dismiss branch change notice",
    onDismiss: input.onDismiss,
  };
}
