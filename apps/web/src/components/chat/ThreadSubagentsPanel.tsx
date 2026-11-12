import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveVisibleSubagentInstances,
  isActiveSubagentStatus,
  isTerminalSubagentStatus,
  type VisibleSubagentInstance,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { ThreadId, type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  CircleStopIcon,
  CircleXIcon,
  ClockIcon,
  LoaderCircleIcon,
  PauseIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { useTranslation } from "../../i18n";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { cn } from "../../lib/utils";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

function SubagentDuration({
  startedAt,
  endedAtMs,
}: {
  readonly startedAt: string;
  readonly endedAtMs: number;
}) {
  const { t } = useTranslation();
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(endedAtMs)) return null;
  const seconds = Math.max(0, Math.floor((endedAtMs - startedMs) / 1000));
  const duration =
    seconds >= 3600
      ? t("{count}h", { count: Math.floor(seconds / 3600) })
      : seconds >= 60
        ? t("{count}m", { count: Math.floor(seconds / 60) })
        : t("{count}s", { count: seconds });
  return (
    <span className="shrink-0 tabular-nums" aria-label={t("Elapsed: {duration}", { duration })}>
      {duration}
    </span>
  );
}

function SubagentElapsed({ startedAt }: { readonly startedAt: string }) {
  const nowMs = useNowSecond();
  return <SubagentDuration startedAt={startedAt} endedAtMs={nowMs} />;
}

function NativeSubagentDetails({ agent }: { readonly agent: VisibleSubagentInstance }) {
  const { t } = useTranslation();
  const fields = [
    { label: t("Task"), value: agent.prompt },
    { label: t("Progress"), value: agent.progress },
    { label: t("Result"), value: agent.error === null ? agent.result : null },
    { label: t("Error"), value: agent.error },
  ];
  return (
    <dl className="space-y-2 px-2.5 pb-2 pl-9 text-2xs">
      {fields.map(({ label, value }) => (
        <div key={label} className="min-w-0">
          <dt className="font-medium text-foreground">{label}</dt>
          <dd className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground [overflow-wrap:anywhere]">
            {value || t("Not reported")}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function SubagentInstanceRow({
  agent,
  environmentId,
  providers,
}: {
  readonly agent: VisibleSubagentInstance;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === agent.providerInstanceId,
  );
  const provider = providers.find((candidate) => candidate.instanceId === agent.providerInstanceId);
  const { modelLabel } = resolveSubagentMetadata({ model: agent.model, provider });
  const title = agent.title.trim() || t("Untitled subagent");
  const running = agent.status === "running";
  const waiting = agent.status === "waiting";
  const terminal = isTerminalSubagentStatus(agent.status);
  const expandable = agent.origin === "provider_native" && agent.childThreadId === null;
  const StatusIcon = running
    ? LoaderCircleIcon
    : waiting
      ? PauseIcon
      : agent.status === "completed"
        ? CheckCircleIcon
        : agent.status === "failed"
          ? CircleXIcon
          : terminal
            ? CircleStopIcon
            : ClockIcon;
  const statusLabel = t(
    {
      pending: "Queued",
      running: "Running",
      waiting: "Waiting",
      idle: "Idle",
      completed: "Completed",
      failed: "Failed",
      cancelled: "Cancelled",
      interrupted: "Interrupted",
    }[agent.status],
  );
  const className = cn(
    "group flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-xs",
    (agent.childThreadId || expandable) &&
      "outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring",
  );
  const content = (
    <>
      <ProviderInstanceIcon
        driverKind={agent.driver}
        displayName={entry?.displayName ?? agent.driver}
        accentColor={entry?.accentColor}
        acpRegistryIconUrl={entry?.acpRegistryIconUrl}
        showBadge={entry?.accentColor !== undefined}
        badgeContent="none"
        className="mt-0.5 size-4 shrink-0"
        iconClassName="size-4"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-foreground" title={title}>
            {title}
          </span>
          <span
            id={`${detailsId}-status`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-2xs",
              running
                ? "text-info"
                : waiting
                  ? "text-warning"
                  : agent.status === "failed"
                    ? "text-destructive"
                    : "text-muted-foreground",
            )}
          >
            <StatusIcon aria-hidden className={cn("size-3", running && "animate-spin")} />
            {statusLabel}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          <span
            id={`${detailsId}-model`}
            className="min-w-0 flex-1 truncate"
            title={entry?.displayName ?? agent.driver}
          >
            {entry?.displayName ?? agent.driver}
            {" · "}
            {agent.model ? modelLabel : t("Model not reported")}
          </span>
          {agent.startedAt ? (
            terminal ? (
              agent.completedAt ? (
                <SubagentDuration
                  startedAt={agent.startedAt}
                  endedAtMs={Date.parse(agent.completedAt)}
                />
              ) : null
            ) : (
              <SubagentElapsed startedAt={agent.startedAt} />
            )
          ) : null}
          {agent.childThreadId ? (
            <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />
          ) : expandable ? (
            <ChevronDownIcon
              aria-hidden
              className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-180")}
            />
          ) : null}
        </div>
        {agent.progress ? (
          <p className="truncate text-2xs text-muted-foreground" title={agent.progress}>
            {agent.progress}
          </p>
        ) : null}
      </div>
    </>
  );
  return (
    <li data-subagent-id={agent.id}>
      {agent.childThreadId ? (
        <Link
          to="/$environmentId/$threadId"
          params={buildThreadRouteParams(
            scopeThreadRef(environmentId, ThreadId.make(agent.childThreadId)),
          )}
          aria-label={t("Open subagent {title}", { title })}
          className={className}
        >
          {content}
        </Link>
      ) : expandable ? (
        <>
          <button
            type="button"
            aria-label={t("Details for subagent {title}", { title })}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-describedby={`${detailsId}-status ${detailsId}-model`}
            onClick={() => setExpanded((value) => !value)}
            className={cn(className, "w-full cursor-pointer text-left")}
          >
            {content}
          </button>
          <div id={detailsId} hidden={!expanded}>
            <NativeSubagentDetails agent={agent} />
          </div>
        </>
      ) : (
        <div className={className}>{content}</div>
      )}
    </li>
  );
}

export function ThreadSubagentsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { t } = useTranslation();
  const thread = useQuietThreadProjection(scopeThreadRef(props.environmentId, props.threadId));
  const providers = useEnvironmentProviders().get(props.environmentId) ?? EMPTY_PROVIDERS;
  const agents = deriveVisibleSubagentInstances(thread?.projection.subagents ?? []);
  if (agents.length === 0) return null;
  const activeCount = agents.filter((agent) => isActiveSubagentStatus(agent.status)).length;
  const recentCount = agents.length - activeCount;
  return (
    <ThreadDetailsSection
      headingId={`thread-details-subagents-${props.threadId}`}
      title={t(recentCount > 0 ? "Subagents" : "Active subagents")}
      data-thread-subagents-panel
      actions={
        <span
          className="rounded-full bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
          aria-label={
            recentCount > 0
              ? t("{active} active subagents, {recent} recent subagents", {
                  active: activeCount,
                  recent: recentCount,
                })
              : t("{count} active subagents", { count: activeCount })
          }
        >
          {agents.length}
        </span>
      }
    >
      <ul className="max-h-64 min-w-0 overflow-y-auto overscroll-contain">
        {agents.map((agent) => (
          <SubagentInstanceRow
            key={agent.id}
            agent={agent}
            environmentId={props.environmentId}
            providers={providers}
          />
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
