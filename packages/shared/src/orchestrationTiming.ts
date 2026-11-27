import { isOrchestrationV2WorkActive, type OrchestrationV2Subagent } from "@t3tools/contracts";

export function deriveSubagentElapsedMs(
  agent: {
    readonly status: OrchestrationV2Subagent["status"];
    readonly startedAt: string | null;
    readonly completedAt: string | null;
    readonly cached?: boolean | undefined;
    readonly durationMs?: number | undefined;
  },
  nowMs: number,
): number | null {
  if (agent.cached) {
    return agent.durationMs !== undefined &&
      Number.isFinite(agent.durationMs) &&
      agent.durationMs >= 0
      ? agent.durationMs
      : null;
  }
  if (agent.startedAt === null) return null;
  const end = isOrchestrationV2WorkActive(agent.status)
    ? nowMs
    : agent.completedAt === null
      ? null
      : Date.parse(agent.completedAt);
  if (end === null) return null;
  const start = Date.parse(agent.startedAt);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) return `${Math.round(durationMs / 100) / 10}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  // Choose the unit after rounding so 59.5 seconds never renders as "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}

export function formatWorkflowDuration(
  durationMs: number,
  resolve: (message: string, values?: Readonly<Record<string, string | number>>) => string,
): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return resolve("{ms}ms", { ms: 0 });
  if (durationMs < 1_000) return resolve("{ms}ms", { ms: Math.max(1, Math.round(durationMs)) });
  if (durationMs < 10_000)
    return resolve("{seconds}s", { seconds: Math.round(durationMs / 100) / 10 });
  const totalSeconds = Math.round(durationMs / 1_000);
  if (totalSeconds < 60) return resolve("{seconds}s", { seconds: totalSeconds });
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours === 0) return resolve("{minutes}m {seconds}s", { minutes, seconds });
  if (minutes > 0) return resolve("{hours}h {minutes}m {seconds}s", { hours, minutes, seconds });
  return seconds > 0
    ? resolve("{hours}h {seconds}s", { hours, seconds })
    : resolve("{hours}h", { hours });
}
