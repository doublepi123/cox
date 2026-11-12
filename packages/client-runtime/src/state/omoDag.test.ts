import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ProviderRef,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveOmoDagRuns, type OmoDagGraph, type OmoDagProjectionSubagent } from "./omoDag.ts";

const parentThreadId = ThreadId.make("parent");
const providerInstanceId = ProviderInstanceId.make("omo-main");

function graph(overrides: Partial<OmoDagGraph> = {}): OmoDagGraph {
  return {
    schemaVersion: 1,
    runId: "run-1",
    parentSessionId: "native-parent",
    generation: 1,
    lastSeq: 4,
    name: "Mass ULW",
    status: "running",
    createdAt: 100,
    updatedAt: 200,
    nodes: [
      { id: "plan", label: "Plan", prompt: "Plan the work", state: "completed", attempt: 1 },
      {
        id: "build",
        label: "Build",
        prompt: "Build the feature",
        state: "running",
        attempt: 2,
        taskId: "task-build",
      },
    ],
    edges: [{ from: "plan", to: "build" }],
    waves: [
      { index: 0, nodeIds: ["plan"] },
      { index: 1, nodeIds: ["build"] },
    ],
    ...overrides,
  };
}

function nativeRef(
  nativeId: string,
  driver = ProviderDriverKind.make("omo"),
): OrchestrationV2ProviderRef {
  return { driver, nativeId, strength: "strong" };
}

function subagent(overrides: Partial<OmoDagProjectionSubagent> = {}): OmoDagProjectionSubagent {
  return {
    id: NodeId.make("coordinator"),
    threadId: parentThreadId,
    origin: "provider_native",
    driver: ProviderDriverKind.make("omo"),
    providerInstanceId,
    childThreadId: null,
    nativeTaskRef: null,
    model: null,
    result: null,
    status: "running",
    ...overrides,
  };
}

describe("OMO dependency graph projection", () => {
  it("shows the matching native task error when the upstream graph omits the node error", () => {
    const failed = graph({
      status: "failed",
      nodes: [
        {
          id: "failed",
          label: "Failed",
          prompt: "Work",
          state: "failed",
          attempt: 1,
          taskId: "task-failed",
        },
      ],
      edges: [],
      waves: [],
    });
    const [run] = deriveOmoDagRuns([
      subagent({ workflow: { phases: [], agents: [], graph: failed } }),
      subagent({
        id: NodeId.make("failed-task"),
        nativeTaskRef: nativeRef("task-failed"),
        status: "failed",
        result: "Original native fixture failure",
      }),
    ]);
    expect(run?.nodes[0]?.lastError).toEqual({
      code: "native_task_failed",
      message: "Original native fixture failure",
    });
    expect(failed.nodes[0]?.lastError).toBeUndefined();
  });
  it("resolves missing node metadata only from the matching native OMO task", () => {
    const matching = subagent({
      id: NodeId.make("worker"),
      nativeTaskRef: nativeRef("task-build"),
      model: "service/actual-model",
      progress: "Editing the graph",
      childThreadId: ThreadId.make("child-build"),
    });
    const runs = deriveOmoDagRuns([
      subagent({ workflow: { phases: [], agents: [], graph: graph() } }),
      matching,
      subagent({
        id: NodeId.make("wrong-instance"),
        providerInstanceId: ProviderInstanceId.make("omo-other"),
        nativeTaskRef: nativeRef("task-build"),
        model: "wrong-instance-model",
        childThreadId: ThreadId.make("wrong-instance-child"),
      }),
      subagent({
        id: NodeId.make("wrong-parent"),
        threadId: ThreadId.make("other-parent"),
        nativeTaskRef: nativeRef("task-build"),
        model: "wrong-parent-model",
      }),
      subagent({
        id: NodeId.make("wrong-origin"),
        origin: "app_owned",
        nativeTaskRef: nativeRef("task-build"),
        model: "wrong-origin-model",
      }),
      subagent({
        id: NodeId.make("wrong-driver"),
        driver: ProviderDriverKind.make("codex"),
        nativeTaskRef: nativeRef("task-build"),
        model: "wrong-driver-model",
      }),
      subagent({
        id: NodeId.make("wrong-native-driver"),
        nativeTaskRef: nativeRef("task-build", ProviderDriverKind.make("codex")),
        model: "wrong-native-driver-model",
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.nodes[1]).toMatchObject({
      id: "build",
      model: "service/actual-model",
      progress: "Editing the graph",
      childThreadId: "child-build",
      state: "running",
      attempt: 2,
    });
  });

  it("uses only actual projected child links and never links pending nodes without a child", () => {
    const pendingGraph = graph({
      nodes: [
        {
          id: "explicit",
          label: "Explicit",
          prompt: "Keep graph values",
          state: "paused",
          attempt: 3,
          taskId: "task-build",
          model: "graph/model",
          progress: "Graph progress",
          childThreadId: ThreadId.make("graph-child"),
        },
        {
          id: "pending",
          label: "Pending",
          prompt: "Wait",
          state: "pending",
          attempt: 0,
        },
      ],
    });
    const [run] = deriveOmoDagRuns([
      subagent({ workflow: { phases: [], agents: [], graph: pendingGraph } }),
      subagent({
        id: NodeId.make("worker"),
        nativeTaskRef: nativeRef("task-build"),
        model: "projection/model",
        progress: "Projection progress",
        childThreadId: ThreadId.make("projection-child"),
      }),
    ]);

    expect(run?.nodes[0]).toMatchObject({
      model: "projection/model",
      progress: "Graph progress",
      childThreadId: "projection-child",
    });
    expect(run?.nodes[1]?.childThreadId).toBeUndefined();
    expect(run?.nodes[1]?.model).toBeUndefined();
  });

  it("keeps multiple runs stable, ordered and free of coordinator pseudo-nodes", () => {
    const older = graph({
      runId: "older",
      name: "Older run",
      updatedAt: 100,
      nodes: [{ id: "only", label: "Only node", prompt: "Work", state: "completed", attempt: 1 }],
      edges: [],
      waves: [{ index: 0, nodeIds: ["only"] }],
    });
    const newer = graph({ runId: "newer", name: "Newer run", updatedAt: 300 });
    const sources = [
      subagent({ id: NodeId.make("first"), workflow: { phases: [], agents: [], graph: older } }),
      subagent({ id: NodeId.make("second"), workflow: { phases: [], agents: [], graph: newer } }),
    ];

    const first = deriveOmoDagRuns(sources);
    const second = deriveOmoDagRuns(sources);
    expect(first.map((run) => run.id)).toEqual(["second:newer", "first:older"]);
    expect(second.map((run) => run.id)).toEqual(first.map((run) => run.id));
    expect(first.flatMap((run) => run.nodes).map((node) => node.id)).toEqual([
      "plan",
      "build",
      "only",
    ]);
    expect(first.flatMap((run) => run.nodes)).not.toContainEqual(
      expect.objectContaining({ id: "coordinator" }),
    );
  });

  it("ignores non-OMO and graph-less subagents without changing snapshot state", () => {
    const snapshot = graph({
      generation: 7,
      lastSeq: 11,
      status: "failed",
      nodes: [
        {
          id: "failed",
          label: "Failed node",
          prompt: "Raw prompt",
          state: "failed",
          attempt: 4,
          lastError: { code: "native_failed", message: "Raw error" },
        },
      ],
    });
    const runs = deriveOmoDagRuns([
      subagent({ workflow: { phases: [], agents: [], graph: snapshot } }),
      subagent({ id: NodeId.make("no-graph") }),
      subagent({
        id: NodeId.make("app"),
        origin: "app_owned",
        workflow: { phases: [], agents: [], graph: graph() },
      }),
      subagent({
        id: NodeId.make("codex"),
        driver: ProviderDriverKind.make("codex"),
        workflow: { phases: [], agents: [], graph: graph() },
      }),
    ]);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ generation: 7, lastSeq: 11, status: "failed" });
    expect(runs[0]?.nodes[0]).toMatchObject({
      state: "failed",
      prompt: "Raw prompt",
      lastError: { code: "native_failed", message: "Raw error" },
    });
    expect(snapshot.lastSeq).toBe(11);
  });
});
