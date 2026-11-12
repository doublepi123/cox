import {
  ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS,
  OrchestrationV2WorkflowGraph,
} from "@t3tools/contracts";
import type { PiRpcRecord } from "@t3tools/provider-pi/server";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const limits = ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS;
const encoder = new TextEncoder();
const decodeGraph = Schema.decodeUnknownOption(OrchestrationV2WorkflowGraph);
const encodeGraph = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2WorkflowGraph));
const maxRuns = 256;
const terminalStatuses = new Set(["completed", "failed", "cancelled"]);

function record(value: unknown): PiRpcRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as PiRpcRecord)
    : {};
}

function counter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.length <= 64
        ? Date.parse(value)
        : Number.NaN;
  return counter(parsed) && parsed <= 8_640_000_000_000_000 ? parsed : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= limits.idBytes &&
    value.trim().length > 0 &&
    encoder.encode(value).byteLength <= limits.idBytes
    ? value
    : undefined;
}

function boundedText(
  value: unknown,
  maxBytes: number,
  state: { truncated: boolean },
): string | undefined {
  if (typeof value !== "string") return undefined;
  const prefix = value.slice(0, maxBytes);
  if (value.length <= maxBytes && encoder.encode(prefix).byteLength <= maxBytes) return value;
  state.truncated = true;
  let result = "";
  let bytes = 0;
  for (const character of prefix) {
    const width = encoder.encode(character).byteLength;
    if (bytes + width > maxBytes) break;
    bytes += width;
    result += character;
  }
  return result;
}

function authoritative(value: PiRpcRecord): boolean {
  return value.schemaVersion === 1 && counter(value.generation) && counter(value.lastSeq);
}

export function parseOmoDagGraph(
  value: unknown,
  parentSessionId?: string,
): OrchestrationV2WorkflowGraph | undefined {
  const run = record(value);
  const snakeCase = typeof run.run_id === "string";
  if (run.schemaVersion !== undefined && run.schemaVersion !== 1) return undefined;
  if (!snakeCase && !authoritative(run)) return undefined;
  const runId = identity(snakeCase ? run.run_id : run.runId);
  const parent = identity(snakeCase ? parentSessionId : run.parentSessionId);
  const createdAt = timestamp(snakeCase ? run.created_at : run.createdAt);
  if (
    runId === undefined ||
    parent === undefined ||
    createdAt === undefined ||
    !Array.isArray(run.nodes) ||
    !Array.isArray(run.edges) ||
    !Array.isArray(run.waves) ||
    run.nodes.length > limits.nodes ||
    run.edges.length > limits.edges ||
    run.waves.length > limits.waves ||
    (run.truncated !== undefined && typeof run.truncated !== "boolean")
  )
    return undefined;
  if (
    snakeCase &&
    ((run.generation !== undefined && !counter(run.generation)) ||
      (run.lastSeq !== undefined && !counter(run.lastSeq)))
  )
    return undefined;
  const state = { truncated: run.truncated === true };
  const nodes: Array<PiRpcRecord> = [];
  let derivedUpdatedAt = createdAt;
  for (const value of run.nodes) {
    const node = record(value);
    const id = identity(node.id);
    const task = snakeCase ? node.task_id : node.taskId;
    const taskId = task === undefined ? undefined : identity(task);
    const child = snakeCase ? node.child_thread_id : node.childThreadId;
    const childThreadId = child === undefined ? undefined : identity(child);
    if (
      id === undefined ||
      (task !== undefined && taskId === undefined) ||
      (child !== undefined && childThreadId === undefined)
    )
      return undefined;
    const started = snakeCase ? node.started_at : node.startedAt;
    const completed = snakeCase ? node.completed_at : node.completedAt;
    const startedAt = timestamp(started);
    const completedAt = timestamp(completed);
    if (
      (started !== undefined && startedAt === undefined) ||
      (completed !== undefined && completedAt === undefined)
    )
      return undefined;
    derivedUpdatedAt = Math.max(derivedUpdatedAt, startedAt ?? 0, completedAt ?? 0);
    const errorValue = snakeCase ? node.last_error : node.lastError;
    const error = record(errorValue);
    const model = boundedText(node.model, limits.modelBytes, state);
    const progress = boundedText(node.progress, limits.progressBytes, state);
    if (
      (node.model !== undefined && model === undefined) ||
      (node.progress !== undefined && progress === undefined)
    )
      return undefined;
    nodes.push({
      id,
      label: boundedText(node.label === undefined ? id : node.label, limits.labelBytes, state),
      prompt: boundedText(node.prompt, limits.promptBytes, state),
      state: node.state,
      attempt: node.attempt,
      ...(taskId === undefined ? {} : { taskId }),
      ...(model === undefined ? {} : { model }),
      ...(childThreadId === undefined ? {} : { childThreadId }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(completedAt === undefined ? {} : { completedAt }),
      ...(progress === undefined ? {} : { progress }),
      ...(errorValue === undefined
        ? {}
        : {
            lastError: {
              code: boundedText(error.code, limits.errorCodeBytes, state),
              message: boundedText(error.message, limits.errorMessageBytes, state),
            },
          }),
    });
  }
  for (const key of snakeCase ? ["started_at", "completed_at"] : ["startedAt", "completedAt"]) {
    if (run[key] === undefined) continue;
    const at = timestamp(run[key]);
    if (at === undefined) return undefined;
    derivedUpdatedAt = Math.max(derivedUpdatedAt, at);
  }
  const updated = snakeCase ? run.updated_at : run.updatedAt;
  const updatedAt = updated === undefined ? derivedUpdatedAt : timestamp(updated);
  if (updatedAt === undefined || (snakeCase && updated === undefined)) return undefined;
  const waves: Array<PiRpcRecord> = [];
  for (const value of run.waves) {
    const wave = record(value);
    const nodeIds = snakeCase ? wave.node_ids : wave.nodeIds;
    if (!Array.isArray(nodeIds) || nodeIds.length > limits.nodes) return undefined;
    waves.push({ index: wave.index, nodeIds });
  }
  const criticalPath = snakeCase ? run.critical_path : run.criticalPath;
  if (
    criticalPath !== undefined &&
    (!Array.isArray(criticalPath) || criticalPath.length > limits.nodes)
  )
    return undefined;
  const name = boundedText(run.name, limits.labelBytes, state);
  const decoded = decodeGraph({
    schemaVersion: 1,
    runId,
    parentSessionId: parent,
    generation: run.generation ?? 0,
    lastSeq: run.lastSeq ?? 0,
    name,
    status: run.status,
    createdAt,
    updatedAt,
    nodes,
    edges: run.edges,
    waves,
    ...(criticalPath === undefined ? {} : { criticalPath }),
    ...(state.truncated ? { truncated: true } : {}),
  });
  return Option.isSome(decoded) ? decoded.value : undefined;
}

function rpcValue(value: unknown): unknown {
  const response = record(value);
  const envelope =
    response.type === "response"
      ? response.success === true
        ? record(response.data)
        : {}
      : response;
  return envelope.ok === true ? envelope.value : undefined;
}

export function omoDagSnapshotFromRpc(value: unknown): PiRpcRecord | undefined {
  const snapshot = record(rpcValue(value));
  return !Object.hasOwn(snapshot, "run_id") &&
    authoritative(snapshot) &&
    parseOmoDagGraph(snapshot) !== undefined
    ? snapshot
    : undefined;
}

export function omoDagRunIdsFromRpc(
  value: unknown,
  parentSessionId: string,
): ReadonlyArray<string> | undefined {
  const data = record(rpcValue(value));
  if (
    identity(parentSessionId) === undefined ||
    (data.schemaVersion !== undefined && data.schemaVersion !== 1) ||
    !Array.isArray(data.runs) ||
    data.runs.length > maxRuns
  )
    return undefined;
  const ids = new Set<string>();
  for (const value of data.runs) {
    const run = record(value);
    const id = identity(run.runId);
    if (
      id === undefined ||
      run.parentSessionId !== parentSessionId ||
      ids.has(id) ||
      (run.schemaVersion !== undefined && run.schemaVersion !== 1)
    )
      return undefined;
    ids.add(id);
  }
  return [...ids];
}

export interface OmoDagRecord extends PiRpcRecord {
  readonly type: "t3.native_subagents";
  readonly nativeThreadId: string;
  readonly details: {
    readonly results: ReadonlyArray<{
      readonly nativeTaskId: string;
      readonly taskRef: string;
      readonly agent: string;
      readonly task: string;
      readonly model?: string;
      readonly status: "pending" | "running" | "waiting" | "completed" | "failed" | "cancelled";
      readonly finished: boolean;
      readonly startedAt: string;
      readonly updatedAt: string;
      readonly completedAt?: string;
      readonly stopReason: "aborted" | "error" | "stop";
      readonly workflow: {
        readonly name: string;
        readonly runHandles: { readonly runId: string };
        readonly phases: readonly [];
        readonly agents: readonly [];
        readonly graph: OrchestrationV2WorkflowGraph;
      };
      readonly messages: ReadonlyArray<{
        readonly role: "assistant";
        readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
      }>;
    }>;
  };
}

export function omoDagEvent(
  graphs: ReadonlyArray<OrchestrationV2WorkflowGraph>,
  sessionFile: string,
): OmoDagRecord {
  return {
    type: "t3.native_subagents",
    nativeThreadId: sessionFile,
    details: {
      results: graphs.map((graph) => {
        const finished = terminalStatuses.has(graph.status);
        const status = graph.status === "paused" ? "waiting" : graph.status;
        const counts = new Map<string, number>();
        for (const node of graph.nodes) counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
        const summary = [...counts].map(([state, count]) => `${count} ${state}`).join(", ");
        const models = new Set(graph.nodes.flatMap((node) => (node.model ? [node.model] : [])));
        const model = models.size === 1 ? [...models][0] : undefined;
        return {
          nativeTaskId: `${graph.parentSessionId}/dag:${graph.runId}`,
          taskRef: graph.runId,
          agent: graph.name,
          task: graph.name,
          ...(model === undefined ? {} : { model }),
          status,
          finished,
          startedAt: DateTime.formatIso(DateTime.makeUnsafe(graph.createdAt)),
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(graph.updatedAt)),
          ...(finished
            ? { completedAt: DateTime.formatIso(DateTime.makeUnsafe(graph.updatedAt)) }
            : {}),
          stopReason:
            graph.status === "cancelled" ? "aborted" : graph.status === "failed" ? "error" : "stop",
          workflow: {
            name: graph.name,
            runHandles: { runId: graph.runId },
            phases: [],
            agents: [],
            graph,
          },
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: `${graph.name}: ${graph.status}${summary ? ` (${summary})` : ""}${graph.truncated ? " [truncated]" : ""}`,
                },
              ],
            },
          ],
        };
      }),
    },
  };
}

interface AcceptedGraph {
  readonly graph: OrchestrationV2WorkflowGraph;
  readonly authoritative: boolean;
  readonly signature: string;
}

export class OmoDagUpdates {
  private sessionId: string | undefined;
  private sessionFile: string | undefined;
  private readonly runs = new Map<string, AcceptedGraph>();
  private readonly activityTimes = new Map<string, number>();
  private evictedThrough = -1;

  reset(): void {
    this.sessionId = undefined;
    this.sessionFile = undefined;
    this.runs.clear();
    this.activityTimes.clear();
    this.evictedThrough = -1;
  }

  bind(value: unknown): void {
    const state = record(value);
    const sessionId = identity(state.sessionId);
    const sessionFile =
      typeof state.sessionFile === "string" &&
      state.sessionFile.length <= 8_192 &&
      state.sessionFile.trim().length > 0
        ? state.sessionFile
        : undefined;
    if (sessionId !== this.sessionId || sessionFile !== this.sessionFile) this.reset();
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  snapshot(): OmoDagRecord | undefined {
    return this.sessionFile === undefined
      ? undefined
      : omoDagEvent(
          [...this.runs.values()].map((run) => run.graph),
          this.sessionFile,
        );
  }

  activity(value: unknown): OmoDagRecord | undefined {
    if (this.sessionId === undefined || this.sessionFile === undefined) return undefined;
    const event = record(value);
    if (event.schemaVersion !== 1) return undefined;
    const runId = identity(event.runId);
    const nodeId = identity(event.nodeId);
    const taskId = identity(event.taskId);
    const at = timestamp(event.at);
    if (runId === undefined || nodeId === undefined || taskId === undefined || at === undefined)
      return undefined;
    const previous = this.runs.get(runId);
    if (
      previous === undefined ||
      terminalStatuses.has(previous.graph.status) ||
      previous.graph.parentSessionId !== this.sessionId
    )
      return undefined;
    const node = previous.graph.nodes.find(
      (candidate) => candidate.id === nodeId && candidate.taskId === taskId,
    );
    if (node === undefined || !["running", "scheduled"].includes(node.state)) return undefined;
    const key = JSON.stringify([runId, nodeId, taskId]);
    if (at <= (this.activityTimes.get(key) ?? -1)) return undefined;
    const state = { truncated: false };
    const progress = boundedText(
      event.lastAssistantLine ?? event.currentTool ?? event.activity,
      limits.progressBytes,
      state,
    );
    if (progress === undefined) return undefined;
    this.activityTimes.set(key, at);
    while (this.activityTimes.size > 1_024)
      this.activityTimes.delete(this.activityTimes.keys().next().value!);
    if (progress === node.progress) return undefined;
    const graph = {
      ...previous.graph,
      nodes: previous.graph.nodes.map((candidate) =>
        candidate.id === nodeId ? { ...candidate, progress } : candidate,
      ),
      ...(state.truncated ? { truncated: true } : {}),
    };
    const decoded = decodeGraph(graph);
    if (Option.isNone(decoded)) return undefined;
    this.runs.set(runId, {
      ...previous,
      graph: decoded.value,
      signature: encodeGraph(decoded.value),
    });
    return omoDagEvent([decoded.value], this.sessionFile);
  }

  observe(value: unknown): OmoDagRecord | undefined {
    if (this.sessionId === undefined || this.sessionFile === undefined) return undefined;
    const event = record(value);
    if (event.type === "extension_event" && event.name !== "omo.dag.updated") return undefined;
    const data = event.type === "extension_event" ? record(event.data) : event;
    if (data.schemaVersion !== undefined && data.schemaVersion !== 1) return undefined;
    let candidates: ReadonlyArray<unknown>;
    let parentSessionId: string | undefined;
    if (Array.isArray(data.runs)) {
      if (
        data.parent_session_id !== this.sessionId ||
        data.runs.length > maxRuns ||
        (data.truncated_runs !== undefined && !counter(data.truncated_runs))
      )
        return undefined;
      candidates = data.runs;
      parentSessionId = this.sessionId;
    } else {
      candidates = [data];
    }
    const parsed: Array<{
      graph: OrchestrationV2WorkflowGraph;
      authoritative: boolean;
      derivedUpdatedAt: boolean;
    }> = [];
    const ids = new Set<string>();
    for (const candidate of candidates) {
      const graph = parseOmoDagGraph(candidate, parentSessionId);
      if (graph === undefined || graph.parentSessionId !== this.sessionId || ids.has(graph.runId))
        return undefined;
      ids.add(graph.runId);
      parsed.push({
        graph:
          counter(data.truncated_runs) && data.truncated_runs > 0
            ? { ...graph, truncated: true }
            : graph,
        authoritative: authoritative(record(candidate)),
        derivedUpdatedAt: record(candidate).updatedAt === undefined,
      });
    }
    const accepted: Array<OrchestrationV2WorkflowGraph> = [];
    for (const candidate of parsed) {
      let graph = candidate.graph;
      const previous = this.runs.get(graph.runId);
      if (previous !== undefined) {
        const old = previous.graph;
        if (graph.createdAt !== old.createdAt) continue;
        if (previous.authoritative && !candidate.authoritative) continue;
        if (
          graph.updatedAt < old.updatedAt &&
          !(candidate.authoritative && candidate.derivedUpdatedAt)
        )
          continue;
        if (previous.authoritative && candidate.authoritative) {
          if (graph.generation < old.generation || graph.lastSeq < old.lastSeq) continue;
          if (
            graph.generation === old.generation &&
            graph.lastSeq === old.lastSeq &&
            graph.updatedAt <= old.updatedAt
          )
            continue;
        } else if (!candidate.authoritative && graph.updatedAt <= old.updatedAt) continue;
        if (graph.updatedAt < old.updatedAt) graph = { ...graph, updatedAt: old.updatedAt };
      } else {
        if (graph.createdAt <= this.evictedThrough) continue;
        if (this.runs.size >= maxRuns) {
          let oldest: AcceptedGraph | undefined;
          for (const entry of this.runs.values())
            if (oldest === undefined || entry.graph.createdAt < oldest.graph.createdAt)
              oldest = entry;
          if (oldest === undefined || graph.createdAt <= oldest.graph.createdAt) continue;
          this.runs.delete(oldest.graph.runId);
          this.evictedThrough = Math.max(this.evictedThrough, oldest.graph.createdAt);
        }
      }
      const signature = encodeGraph(graph);
      if (previous?.signature === signature) {
        if (candidate.authoritative && !previous.authoritative)
          this.runs.set(graph.runId, { ...previous, authoritative: true });
        continue;
      }
      this.runs.set(graph.runId, { graph, authoritative: candidate.authoritative, signature });
      accepted.push(graph);
    }
    return accepted.length === 0 ? undefined : omoDagEvent(accepted, this.sessionFile);
  }
}
