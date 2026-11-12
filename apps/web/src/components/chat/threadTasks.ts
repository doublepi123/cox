import type {
  OrchestrationV2PlanArtifact,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

export type ThreadTodoList = Extract<OrchestrationV2PlanArtifact, { readonly kind: "todo_list" }>;

export function deriveCurrentTodoList(
  projection: Pick<OrchestrationV2ThreadProjection, "plans" | "runs">,
): ThreadTodoList | null {
  const ordinals = new Map(projection.runs.map((run) => [run.id, run.ordinal]));
  let current: ThreadTodoList | null = null;
  const snapshot = projection.plans.findLast(
    (plan): plan is ThreadTodoList =>
      plan.kind === "todo_list" && plan.runId === null && plan.status !== "superseded",
  );
  if (snapshot !== undefined) return snapshot.steps.length === 0 ? null : snapshot;
  let currentOrdinal = -1;
  for (const plan of projection.plans) {
    if (plan.kind !== "todo_list" || plan.status === "superseded" || plan.runId === null) {
      continue;
    }
    const ordinal = ordinals.get(plan.runId);
    if (ordinal === undefined || ordinal < currentOrdinal) continue;
    current = plan;
    currentOrdinal = ordinal;
  }
  if (current === null || current.steps.length === 0) return null;
  const finished = current.steps.every((step) => step.status === "completed");
  const latestOrdinal = Math.max(...projection.runs.map((run) => run.ordinal));
  return finished && currentOrdinal < latestOrdinal ? null : current;
}
