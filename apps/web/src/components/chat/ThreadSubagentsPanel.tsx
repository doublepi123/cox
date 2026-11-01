import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveActiveSubagentInstances,
  type ActiveSubagentInstance,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { ThreadId, type EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { ArrowUpRightIcon, ClockIcon, LoaderCircleIcon, PauseIcon } from "lucide-react";

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

function SubagentElapsed({ startedAt }: { readonly startedAt: string }) {
  const { t } = useTranslation();
  const nowMs = useNowSecond();
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return null;
  const seconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
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

function SubagentInstanceRow({
  agent,
  environmentId,
  providers,
}: {
  readonly agent: ActiveSubagentInstance;
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const { t } = useTranslation();
  const entry = deriveProviderInstanceEntries(providers).find(
    (candidate) => candidate.instanceId === agent.providerInstanceId,
  );
  const provider = providers.find((candidate) => candidate.instanceId === agent.providerInstanceId);
  const { modelLabel } = resolveSubagentMetadata({ model: agent.model, provider });
  const title = agent.title.trim() || t("Untitled subagent");
  const running = agent.status === "running";
  const waiting = agent.status === "waiting";
  const StatusIcon = running ? LoaderCircleIcon : waiting ? PauseIcon : ClockIcon;
  const statusLabel = t(running ? "Running" : waiting ? "Waiting" : "Queued");
  const className = cn(
    "group flex min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-xs",
    agent.childThreadId &&
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
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-2xs",
              running ? "text-info" : waiting ? "text-warning" : "text-muted-foreground",
            )}
          >
            <StatusIcon aria-hidden className={cn("size-3", running && "animate-spin")} />
            {statusLabel}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate" title={entry?.displayName ?? agent.driver}>
            {entry?.displayName ?? agent.driver}
            {" · "}
            {agent.model ? modelLabel : t("Model not reported")}
          </span>
          {agent.startedAt ? <SubagentElapsed startedAt={agent.startedAt} /> : null}
          {agent.childThreadId ? (
            <ArrowUpRightIcon aria-hidden className="size-3 shrink-0" />
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
  const agents = deriveActiveSubagentInstances(thread?.projection.subagents ?? []);
  if (agents.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId={`thread-details-subagents-${props.threadId}`}
      title={t("Active subagents")}
      data-thread-subagents-panel
      actions={
        <span
          className="rounded-full bg-muted px-1.5 py-0.5 text-2xs tabular-nums text-muted-foreground"
          aria-label={t("{count} active subagents", { count: agents.length })}
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
