import type {
  OrchestrationV2Subagent,
  OrchestrationV2WorkflowGraph,
  ThreadId,
} from "@t3tools/contracts";

export type OmoDagGraph = OrchestrationV2WorkflowGraph;
export type OmoDagGraphNode = OmoDagGraph["nodes"][number];
export type OmoDagNodeState = OmoDagGraphNode["state"];
export type OmoDagRunStatus = OmoDagGraph["status"];

export type OmoDagProjectionSubagent = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "threadId"
  | "origin"
  | "driver"
  | "providerInstanceId"
  | "childThreadId"
  | "nativeTaskRef"
  | "model"
  | "progress"
  | "result"
  | "status"
  | "workflow"
>;

export type OmoDagRun = Omit<OmoDagGraph, "nodes"> & {
  readonly id: string;
  readonly coordinatorId: OrchestrationV2Subagent["id"];
  readonly parentThreadId: ThreadId;
  readonly providerInstanceId: OrchestrationV2Subagent["providerInstanceId"];
  readonly nodes: ReadonlyArray<OmoDagGraphNode>;
};

function nativeTaskKey(
  subagent: Pick<OmoDagProjectionSubagent, "providerInstanceId" | "threadId">,
  taskId: string,
): string {
  return `${subagent.providerInstanceId}\0${subagent.threadId}\0${taskId}`;
}

export function deriveOmoDagRuns(
  subagents: ReadonlyArray<OmoDagProjectionSubagent>,
): ReadonlyArray<OmoDagRun> {
  const nativeTasks = new Map<string, OmoDagProjectionSubagent>();
  for (const subagent of subagents) {
    const taskId = subagent.nativeTaskRef?.nativeId;
    if (
      subagent.origin !== "provider_native" ||
      subagent.driver !== "omo" ||
      subagent.nativeTaskRef?.driver !== "omo" ||
      taskId === null ||
      taskId === undefined
    ) {
      continue;
    }
    const key = nativeTaskKey(subagent, taskId);
    if (!nativeTasks.has(key)) nativeTasks.set(key, subagent);
  }

  return subagents
    .flatMap((subagent): Array<OmoDagRun> => {
      const graph = subagent.workflow?.graph;
      if (
        subagent.origin !== "provider_native" ||
        subagent.driver !== "omo" ||
        graph === undefined ||
        graph.schemaVersion !== 1
      ) {
        return [];
      }
      const nodes = graph.nodes.map((node) => {
        const match =
          node.taskId === undefined
            ? undefined
            : nativeTasks.get(nativeTaskKey(subagent, node.taskId));
        const resolved = match?.id === subagent.id ? undefined : match;
        return {
          ...node,
          model: resolved?.model ?? node.model ?? undefined,
          childThreadId: resolved?.childThreadId ?? undefined,
          progress: node.progress ?? resolved?.progress ?? undefined,
          ...(node.lastError === undefined &&
          node.state === "failed" &&
          resolved?.status === "failed" &&
          resolved.result
            ? {
                lastError: { code: "native_task_failed", message: resolved.result.slice(0, 4_096) },
              }
            : {}),
        };
      });
      return [
        {
          ...graph,
          id: `${subagent.id}:${graph.runId}`,
          coordinatorId: subagent.id,
          parentThreadId: subagent.threadId,
          providerInstanceId: subagent.providerInstanceId,
          nodes,
        },
      ];
    })
    .toSorted(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt ||
        left.runId.localeCompare(right.runId) ||
        left.id.localeCompare(right.id),
    );
}
