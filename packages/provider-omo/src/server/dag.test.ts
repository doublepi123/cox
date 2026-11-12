import { describe, expect, it } from "@effect/vitest";
import {
  ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS,
  type OrchestrationV2WorkflowGraph,
} from "@t3tools/contracts";

import {
  OmoDagUpdates,
  omoDagEvent,
  omoDagRunIdsFromRpc,
  omoDagSnapshotFromRpc,
  parseOmoDagGraph,
} from "./dag.ts";

const limits = ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS;
const sessionId = "de82c3b6-ecee-49ce-bc01-aac1edf215ad";
const sessionFile = "/isolated/session.jsonl";
const runId = "dag_c075963b-d26d-46d4-95cb-6c78da46dc8c";
const createdAt = "2026-11-12T12:20:50.026Z";
const updatedAt = "2026-11-12T12:20:50.640Z";
const binding = { sessionId, sessionFile };

function snapshot() {
  return {
    schemaVersion: 1,
    runId,
    runKey: "cox-native-mass-acceptance",
    name: "Cox native mass acceptance",
    parentSessionId: sessionId,
    rootSessionId: sessionId,
    status: "completed",
    generation: 1,
    createdAt,
    startedAt: "2026-11-12T12:20:50.049Z",
    completedAt: updatedAt,
    lastSeq: 15,
    nodes: [
      {
        id: "inspect",
        prompt:
          "TASK: Return a local fixture result. DELIVERABLE: local fixture. SCOPE: no files. VERIFY: local result. STOP WHEN: response returned.",
        route: { kind: "category", category: "quick" },
        dependsOn: [],
        state: "completed",
        attempt: 1,
        createdAt,
        taskId: "st_01a1cfb4",
        startedAt: "2026-11-12T12:20:50.350Z",
        completedAt: "2026-11-12T12:20:50.452Z",
        output: "Local fixture result for main",
      },
      {
        id: "verify",
        prompt:
          "TASK: Verify the local fixture. DELIVERABLE: local verification. SCOPE: no files. VERIFY: local result. STOP WHEN: response returned.",
        route: { kind: "category", category: "quick" },
        dependsOn: ["inspect"],
        state: "completed",
        attempt: 1,
        createdAt,
        taskId: "st_01a1cfb5",
        startedAt: "2026-11-12T12:20:50.591Z",
        completedAt: "2026-11-12T12:20:50.625Z",
        output: "Local fixture result for main",
      },
    ],
    edges: [{ from: "inspect", to: "verify" }],
    waves: [
      { index: 0, nodeIds: ["inspect"] },
      { index: 1, nodeIds: ["verify"] },
    ],
    criticalPath: ["inspect", "verify"],
    bottlenecks: [
      { nodeId: "inspect", blockedCount: 1 },
      { nodeId: "verify", blockedCount: 0 },
    ],
    diagnostics: [],
    counts: { total: 2, completed: 2, pending: 0, running: 0 },
  };
}

function updated() {
  const run = snapshot();
  return {
    parent_session_id: sessionId,
    runs: [
      {
        run_id: run.runId,
        run_key: run.runKey,
        name: run.name,
        status: run.status,
        created_at: run.createdAt,
        updated_at: updatedAt,
        completed_at: run.completedAt,
        counts: run.counts,
        nodes: run.nodes.map((node) => ({
          id: node.id,
          prompt: node.prompt,
          depends_on: node.dependsOn,
          state: node.state,
          attempt: node.attempt,
          created_at: node.createdAt,
          task_id: node.taskId,
          started_at: node.startedAt,
          completed_at: node.completedAt,
        })),
        edges: run.edges,
        waves: run.waves.map((wave) => ({ index: wave.index, node_ids: wave.nodeIds })),
      },
    ],
  };
}

function bound() {
  const updates = new OmoDagUpdates();
  updates.bind(binding);
  return updates;
}

function graph(value: unknown = snapshot()) {
  const parsed = parseOmoDagGraph(value);
  expect(parsed).toBeDefined();
  return parsed!;
}

describe("parseOmoDagGraph", () => {
  it("parses the pinned native completed fixture with authoritative topology and raw task IDs", () => {
    const input = snapshot();
    const parsed = graph(input);
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      runId,
      parentSessionId: sessionId,
      generation: 1,
      lastSeq: 15,
      status: "completed",
      createdAt: Date.parse(createdAt),
      updatedAt: Date.parse(updatedAt),
      nodes: [
        { id: "inspect", label: "inspect", taskId: "st_01a1cfb4", attempt: 1 },
        { id: "verify", label: "verify", taskId: "st_01a1cfb5", attempt: 1 },
      ],
      edges: input.edges,
      waves: input.waves,
      criticalPath: input.criticalPath,
    });
    expect(parsed).not.toHaveProperty("counts");
    expect(parsed.nodes[0]).not.toHaveProperty("output");
    expect(input.nodes[0]?.prompt).toBe(parsed.nodes[0]?.prompt);
  });

  it("normalizes snake_case updated snapshots without inventing a sequence or generation", () => {
    const input = updated();
    const parsed = parseOmoDagGraph(input.runs[0], input.parent_session_id);
    expect(parsed).toMatchObject({
      generation: 0,
      lastSeq: 0,
      nodes: [{ taskId: "st_01a1cfb4" }, { taskId: "st_01a1cfb5" }],
      waves: snapshot().waves,
      edges: snapshot().edges,
    });
    expect(parseOmoDagGraph(input.runs[0])).toBeUndefined();
  });

  it("normalizes a pending started snapshot without optional run or node timestamps", () => {
    const input = snapshot();
    const parsed = graph({
      ...input,
      status: "pending",
      lastSeq: 1,
      startedAt: undefined,
      completedAt: undefined,
      nodes: input.nodes.map((node) => ({
        ...node,
        state: "pending",
        attempt: 0,
        taskId: undefined,
        startedAt: undefined,
        completedAt: undefined,
      })),
    });
    expect(parsed.updatedAt).toBe(Date.parse(createdAt));
    expect(parsed.nodes[0]?.taskId).toBeUndefined();
  });

  it("normalizes native snake_case failure details and wave references", () => {
    const input = updated();
    const run = input.runs[0]!;
    const parsed = parseOmoDagGraph(
      {
        ...run,
        nodes: run.nodes.map((node) => ({
          ...node,
          state: "failed",
          last_error: { code: "native_failure", message: "Failed native attempt" },
        })),
      },
      sessionId,
    );
    expect(parsed?.nodes[0]?.lastError).toEqual({
      code: "native_failure",
      message: "Failed native attempt",
    });
    expect(parsed?.waves).toEqual(snapshot().waves);
  });

  it.each([
    "pending",
    "blocked",
    "scheduled",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "skipped",
  ])("preserves node state %s", (state) => {
    const input = snapshot();
    expect(
      graph({ ...input, nodes: input.nodes.map((node) => ({ ...node, state })) }).nodes[0]?.state,
    ).toBe(state);
  });

  it("normalizes paused errors, optional child links, models and progress", () => {
    const input = snapshot();
    const node = input.nodes[0]!;
    const parsed = graph({
      ...input,
      status: "paused",
      nodes: [
        {
          ...node,
          state: "paused",
          label: "Inspect current state",
          model: "cox/main",
          childThreadId: "thread-native-inspect",
          progress: "Waiting for permission",
          lastError: { code: "lost_while_paused", message: "Native child paused" },
        },
        input.nodes[1],
      ],
    });
    expect(parsed.nodes[0]).toMatchObject({
      label: "Inspect current state",
      model: "cox/main",
      childThreadId: "thread-native-inspect",
      progress: "Waiting for permission",
      lastError: { code: "lost_while_paused", message: "Native child paused" },
    });
  });

  it("bounds every display string on UTF-8 boundaries and signals truncation", () => {
    const input = snapshot();
    const parsed = graph({
      ...input,
      name: "界".repeat(2_000),
      nodes: input.nodes.map((node) => ({
        ...node,
        label: "😀".repeat(2_000),
        prompt: "界".repeat(20_000),
        model: "a".repeat(1_000),
        progress: "x".repeat(10_000),
        lastError: { code: "x".repeat(1_000), message: "😀".repeat(5_000) },
      })),
    });
    expect(parsed.truncated).toBe(true);
    for (const [text, limit] of [
      [parsed.name, limits.labelBytes],
      [parsed.nodes[0]!.label, limits.labelBytes],
      [parsed.nodes[0]!.prompt, limits.promptBytes],
      [parsed.nodes[0]!.model!, limits.modelBytes],
      [parsed.nodes[0]!.progress!, limits.progressBytes],
      [parsed.nodes[0]!.lastError!.code, limits.errorCodeBytes],
      [parsed.nodes[0]!.lastError!.message, limits.errorMessageBytes],
    ] as const) {
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(limit);
      expect(text).not.toContain("�");
    }
  });

  it("rejects malformed identity, status, counters and timestamps", () => {
    const input = snapshot();
    for (const fields of [
      { schemaVersion: 2 },
      { schemaVersion: undefined },
      { generation: undefined },
      { generation: -1 },
      { generation: "1" },
      { lastSeq: Number.MAX_SAFE_INTEGER + 1 },
      { lastSeq: undefined },
      { runId: "x".repeat(limits.idBytes + 1) },
      { parentSessionId: " " },
      { status: "waiting" },
      { createdAt: "not a date" },
      { updatedAt: "invalid" },
      { updatedAt: "2026-11-12T12:20:49.000Z" },
      { completedAt: null },
      { truncated: "yes" },
      { edges: undefined },
      { waves: undefined },
      { nodes: null },
      { nodes: [{ ...input.nodes[0], attempt: -1 }, input.nodes[1]] },
      { nodes: [{ ...input.nodes[0], taskId: "x".repeat(1_000) }, input.nodes[1]] },
      { nodes: [{ ...input.nodes[0], childThreadId: 123 }, input.nodes[1]] },
      { nodes: [{ ...input.nodes[0], startedAt: "invalid" }, input.nodes[1]] },
      { nodes: [{ ...input.nodes[0], lastError: null }, input.nodes[1]] },
      { nodes: [{ ...input.nodes[0], progress: {} }, input.nodes[1]] },
    ])
      expect(parseOmoDagGraph({ ...input, ...fields })).toBeUndefined();
  });

  it("rejects cyclic, duplicate, foreign and oversized topology without cutting dependencies", () => {
    const input = snapshot();
    for (const fields of [
      { nodes: [input.nodes[0], input.nodes[0]] },
      { nodes: Array.from({ length: 257 }, (_, index) => ({ ...input.nodes[0], id: `${index}` })) },
      { edges: [{ from: "foreign", to: "verify" }] },
      { edges: [input.edges[0], input.edges[0]] },
      { edges: [...input.edges, { from: "verify", to: "inspect" }] },
      { edges: Array.from({ length: 2_049 }, () => input.edges[0]) },
      { waves: [{ index: 0, nodeIds: ["foreign"] }] },
      { waves: Array.from({ length: 257 }, (_, index) => ({ index, nodeIds: [] })) },
      { criticalPath: ["foreign"] },
    ])
      expect(parseOmoDagGraph({ ...input, ...fields })).toBeUndefined();
  });

  it("does not leak later mutation of native topology into accepted snapshots", () => {
    const input = snapshot();
    const parsed = graph(input);
    input.edges[0]!.from = "changed";
    input.waves[0]!.nodeIds[0] = "changed";
    input.criticalPath[0] = "changed";
    input.nodes[0]!.prompt = "changed";
    expect(parsed.edges[0]?.from).toBe("inspect");
    expect(parsed.waves[0]?.nodeIds[0]).toBe("inspect");
    expect(parsed.criticalPath?.[0]).toBe("inspect");
    expect(parsed.nodes[0]?.prompt).not.toBe("changed");
  });
});

describe("OMO DAG RPC hydration", () => {
  it("accepts only strict native ok envelopes, including successful Pi response wrappers", () => {
    const input = snapshot();
    expect(omoDagSnapshotFromRpc({ ok: true, value: input })).toBe(input);
    expect(
      omoDagSnapshotFromRpc({ type: "response", success: true, data: { ok: true, value: input } }),
    ).toBe(input);
    for (const value of [
      input,
      { ok: false, value: input },
      { ok: "true", value: input },
      { value: input },
      { type: "response", success: false, data: { ok: true, value: input } },
      { type: "response", data: { ok: true, value: input } },
      { ok: true, value: { ...input, schemaVersion: 2 } },
      { ok: true, value: { ...input, lastSeq: undefined } },
      { ok: true, value: { snapshot: input } },
      { ok: true, value: updated().runs[0] },
    ])
      expect(omoDagSnapshotFromRpc(value)).toBeUndefined();
  });

  it("extracts owned hydration run IDs from bounded successful list responses", () => {
    const value = { runs: [snapshot()], limit: 256 };
    expect(omoDagRunIdsFromRpc({ ok: true, value }, sessionId)).toEqual([runId]);
    expect(
      omoDagRunIdsFromRpc(
        { type: "response", success: true, data: { ok: true, value } },
        sessionId,
      ),
    ).toEqual([runId]);
    expect(omoDagRunIdsFromRpc({ ok: true, value: { runs: [] } }, sessionId)).toEqual([]);
    for (const data of [
      { runs: [{ ...snapshot(), parentSessionId: "other" }] },
      { runs: [{ ...snapshot(), runId: " " }] },
      { runs: [snapshot(), snapshot()] },
      { runs: Array.from({ length: 257 }, (_, index) => ({ ...snapshot(), runId: `${index}` })) },
      {},
    ])
      expect(omoDagRunIdsFromRpc({ ok: true, value: data }, sessionId)).toBeUndefined();
    expect(omoDagRunIdsFromRpc({ ok: false, value }, sessionId)).toBeUndefined();
    expect(omoDagRunIdsFromRpc(value, sessionId)).toBeUndefined();
  });
});

describe("omoDagEvent", () => {
  it.each([
    ["pending", "pending", false],
    ["running", "running", false],
    ["paused", "waiting", false],
    ["completed", "completed", true],
    ["failed", "failed", true],
    ["cancelled", "cancelled", true],
  ] as const)("maps %s to the existing %s subagent status", (nativeStatus, status, finished) => {
    const input = graph({ ...snapshot(), status: nativeStatus });
    const event = omoDagEvent([input], sessionFile);
    expect(event.type).toBe("t3.native_subagents");
    expect(event.nativeThreadId).toBe(sessionFile);
    expect(event.details.results).toHaveLength(1);
    const result = event.details.results[0]!;
    expect(result).toMatchObject({
      nativeTaskId: `${sessionId}/dag:${runId}`,
      taskRef: runId,
      agent: input.name,
      task: input.name,
      status,
      finished,
      startedAt: createdAt,
      updatedAt,
      workflow: { name: input.name, runHandles: { runId }, phases: [], agents: [], graph: input },
    });
    expect(result.completedAt).toBe(finished ? updatedAt : undefined);
    expect(result.stopReason).toBe(
      nativeStatus === "failed" ? "error" : nativeStatus === "cancelled" ? "aborted" : "stop",
    );
    expect(result.messages[0]?.content[0]?.text).toContain(nativeStatus);
  });

  it("emits only graph coordinators and exposes raw node task references for UI joins", () => {
    const first = graph();
    const second = { ...first, runId: "dag-second" };
    const event = omoDagEvent([first, second], sessionFile);
    expect(event.details.results.map((result) => result.taskRef)).toEqual([runId, "dag-second"]);
    expect(event.details.results[0]?.workflow.graph.nodes.map((node) => node.taskId)).toEqual([
      "st_01a1cfb4",
      "st_01a1cfb5",
    ]);
    expect(event.details.results.some((result) => result.taskRef.startsWith("st_"))).toBe(false);
  });

  it("exposes a common model only when node models agree and signals text truncation", () => {
    const input = graph();
    const modeled: OrchestrationV2WorkflowGraph = {
      ...input,
      truncated: true,
      nodes: input.nodes.map((node) => ({ ...node, model: "cox/main" })),
    };
    const first = omoDagEvent([modeled], sessionFile).details.results[0]!;
    expect(first.model).toBe("cox/main");
    expect(first.messages[0]?.content[0]?.text).toContain("[truncated]");
    expect(
      omoDagEvent(
        [
          {
            ...modeled,
            nodes: modeled.nodes.map((node, index) => ({ ...node, model: `${index}` })),
          },
        ],
        sessionFile,
      ).details.results[0]?.model,
    ).toBeUndefined();
  });
});

describe("OmoDagUpdates", () => {
  it("scopes unsequenced activity to an owned active task without advancing the ledger", () => {
    const updates = new OmoDagUpdates();
    updates.bind(binding);
    const run = snapshot();
    const active = {
      ...run,
      status: "running",
      nodes: run.nodes.map((node) => ({ ...node, state: "running" })),
    };
    updates.observe(active);
    const activity = {
      schemaVersion: 1,
      runId,
      nodeId: "inspect",
      taskId: "st_01a1cfb4",
      at: "2026-11-12T12:20:51Z",
      activity: "tool",
      currentTool: "read",
      lastAssistantLine: "Inspecting native graph",
    };
    const result = updates.activity(activity)?.details.results[0]?.workflow.graph;
    expect(result).toMatchObject({ lastSeq: 15, generation: 1, updatedAt: Date.parse(updatedAt) });
    expect(result?.nodes[0]?.progress).toBe("Inspecting native graph");
    expect(updates.activity(activity)).toBeUndefined();
    expect(updates.snapshot()?.details.results[0]?.workflow.graph.nodes[0]?.progress).toBe(
      "Inspecting native graph",
    );
    expect(updates.activity({ ...activity, runId: "foreign" })).toBeUndefined();
    expect(updates.activity({ ...activity, taskId: "old-attempt" })).toBeUndefined();
    expect(updates.activity({ ...activity, schemaVersion: 2 })).toBeUndefined();
    updates.observe({ ...run, lastSeq: 16 });
    expect(updates.activity({ ...activity, at: "2026-11-12T12:20:52Z" })).toBeUndefined();
    updates.bind({ ...binding, sessionId: "other" });
    expect(updates.activity(activity)).toBeUndefined();
  });
  it("requires a bound native session/file and never accepts cross-session graphs", () => {
    const updates = new OmoDagUpdates();
    expect(updates.observe(snapshot())).toBeUndefined();
    updates.bind({ sessionId });
    expect(updates.observe(snapshot())).toBeUndefined();
    updates.bind(binding);
    expect(updates.observe({ ...snapshot(), parentSessionId: "foreign" })).toBeUndefined();
    expect(updates.observe({ ...updated(), parent_session_id: "foreign" })).toBeUndefined();
    expect(updates.observe(snapshot())?.nativeThreadId).toBe(sessionFile);
  });

  it("accepts both raw updated payloads and the pinned extension-event wrapper", () => {
    const updates = bound();
    const value = updated();
    expect(
      updates.observe({ type: "extension_event", name: "omo.dag.updated", data: value })?.details
        .results[0]?.workflow.graph.lastSeq,
    ).toBe(0);
    expect(updates.observe(value)).toBeUndefined();
    expect(
      updates.observe({ type: "extension_event", name: "omo.task.updated", data: value }),
    ).toBeUndefined();
  });

  it("deduplicates snapshots and rejects stale generation, sequence and explicit timestamp", () => {
    const updates = bound();
    expect(updates.observe(snapshot())).toBeDefined();
    expect(updates.observe(snapshot())).toBeUndefined();
    expect(updates.observe({ ...snapshot(), lastSeq: 14 })).toBeUndefined();
    expect(updates.observe({ ...snapshot(), generation: 0, lastSeq: 99 })).toBeUndefined();
    expect(updates.observe({ ...snapshot(), lastSeq: 16, updatedAt: createdAt })).toBeUndefined();
    expect(
      updates.observe({ ...snapshot(), createdAt: "2026-11-12T12:20:50.025Z", lastSeq: 16 }),
    ).toBeUndefined();
    expect(updates.observe({ ...snapshot(), status: "failed" })).toBeUndefined();
    expect(
      updates.observe({ ...snapshot(), lastSeq: 16, status: "failed" })?.details.results[0]?.status,
    ).toBe("failed");
  });

  it("allows unsequenced snapshots only while provisional and newer by updated_at", () => {
    const updates = bound();
    const input = updated();
    expect(updates.observe(input)).toBeDefined();
    const run = input.runs[0]!;
    expect(
      updates.observe({ ...input, runs: [{ ...run, updated_at: createdAt }] }),
    ).toBeUndefined();
    expect(updates.observe({ ...input, runs: [{ ...run, status: "failed" }] })).toBeUndefined();
    expect(
      updates.observe({
        ...input,
        runs: [{ ...run, status: "failed", updated_at: "2026-11-12T12:20:50.650Z" }],
      })?.details.results[0]?.status,
    ).toBe("failed");
    const authoritative = updates.observe(snapshot())?.details.results[0]?.workflow.graph;
    expect(authoritative).toMatchObject({ generation: 1, lastSeq: 15 });
    expect(authoritative?.updatedAt).toBe(Date.parse("2026-11-12T12:20:50.650Z"));
    expect(
      updates.observe({
        ...input,
        runs: [{ ...run, status: "running", updated_at: "2026-11-12T12:20:51.000Z" }],
      }),
    ).toBeUndefined();
  });

  it("handles a same-task retry and generation advance without retaining prior attempt errors", () => {
    const updates = bound();
    const input = snapshot();
    const failed = {
      ...input,
      status: "failed",
      nodes: input.nodes.map((node) => ({
        ...node,
        state: "failed",
        lastError: { code: "failure", message: "Prior attempt failed" },
      })),
    };
    const before = updates.observe(failed)!.details.results[0]!;
    const retry = {
      ...input,
      status: "running",
      generation: 2,
      lastSeq: 20,
      completedAt: undefined,
      nodes: input.nodes.map((node) => ({
        ...node,
        state: "running",
        attempt: 2,
        completedAt: undefined,
      })),
    };
    const after = updates.observe(retry)!.details.results[0]!;
    expect(after.nativeTaskId).toBe(before.nativeTaskId);
    expect(after.finished).toBe(false);
    expect(after.completedAt).toBeUndefined();
    expect(after.workflow.graph.nodes[0]).toMatchObject({ attempt: 2, taskId: "st_01a1cfb4" });
    expect(after.workflow.graph.nodes[0]?.lastError).toBeUndefined();
    expect(after.workflow.graph.updatedAt).toBe(before.workflow.graph.updatedAt);
    expect(updates.observe({ ...input, generation: 1, lastSeq: 25 })).toBeUndefined();
    expect(updates.observe({ ...retry, generation: 3, lastSeq: 19 })).toBeUndefined();
    expect(updates.observe(retry)).toBeUndefined();
  });

  it("accepts same-generation task reattachment and maintains an independent cursor for each run", () => {
    const updates = bound();
    const input = snapshot();
    updates.observe(input);
    const reattached = {
      ...input,
      lastSeq: 16,
      status: "running",
      nodes: input.nodes.map((node) => ({ ...node, state: "running", attempt: 2 })),
    };
    expect(updates.observe(reattached)?.details.results[0]?.workflow.graph.nodes[0]).toMatchObject({
      taskId: "st_01a1cfb4",
      attempt: 2,
      state: "running",
    });
    expect(
      updates.observe({ ...input, runId: "second-run", lastSeq: 1 })?.details.results[0]?.taskRef,
    ).toBe("second-run");
    expect(updates.observe({ ...input, lastSeq: 15 })).toBeUndefined();
    expect(
      updates.observe({ ...input, runId: "second-run", lastSeq: 2 })?.details.results[0]?.workflow
        .graph.lastSeq,
    ).toBe(2);
  });

  it("replaces amended topology wholesale and preserves supplied edges, waves and new task IDs", () => {
    const updates = bound();
    const input = snapshot();
    updates.observe(input);
    const amended = {
      ...input,
      generation: 2,
      lastSeq: 30,
      nodes: [
        { ...input.nodes[0], prompt: "Amended inspection", attempt: 2, taskId: "st-new" },
        input.nodes[1],
        { ...input.nodes[1], id: "review", label: "Review", dependsOn: ["verify"] },
      ],
      edges: [...input.edges, { from: "verify", to: "review" }],
      waves: [...input.waves, { index: 2, nodeIds: ["review"] }],
      criticalPath: ["inspect", "verify", "review"],
      amendHistory: [{ addedNodeIds: ["review"] }],
    };
    const accepted = updates.observe(amended)?.details.results[0]?.workflow.graph;
    expect(accepted?.nodes).toHaveLength(3);
    expect(accepted?.nodes[0]).toMatchObject({
      prompt: "Amended inspection",
      taskId: "st-new",
      attempt: 2,
    });
    expect(accepted?.edges).toEqual(amended.edges);
    expect(accepted?.waves).toEqual(amended.waves);
    expect(accepted?.criticalPath).toEqual(amended.criticalPath);
  });

  it("clears the ledger on session/file switches and reset, preserving it on an identical bind", () => {
    const updates = bound();
    expect(updates.observe(snapshot())).toBeDefined();
    updates.bind(binding);
    expect(updates.observe(snapshot())).toBeUndefined();
    updates.bind({ sessionId: "session-other", sessionFile: "/isolated/other.jsonl" });
    expect(updates.observe(snapshot())).toBeUndefined();
    expect(
      updates.observe({ ...snapshot(), parentSessionId: "session-other" })?.nativeThreadId,
    ).toBe("/isolated/other.jsonl");
    updates.bind(binding);
    expect(updates.observe(snapshot())).toBeDefined();
    updates.bind({ ...binding, sessionFile: "/isolated/new-file.jsonl" });
    expect(updates.observe(snapshot())?.nativeThreadId).toBe("/isolated/new-file.jsonl");
    updates.reset();
    expect(updates.observe(snapshot())).toBeUndefined();
  });

  it("rejects invalid wholesale batches atomically and preserves accepted runs on empty updates", () => {
    const updates = bound();
    const input = updated();
    expect(
      updates.observe({
        ...input,
        runs: [...input.runs, { ...input.runs[0], run_id: "bad", nodes: [] }],
      }),
    ).toBeUndefined();
    expect(updates.observe(input)).toBeDefined();
    expect(updates.observe({ ...input, runs: [] })).toBeUndefined();
    expect(updates.observe(input)).toBeUndefined();
    expect(updates.observe({ ...input, runs: [input.runs[0], input.runs[0]] })).toBeUndefined();
    expect(updates.observe({ ...input, schemaVersion: 2 })).toBeUndefined();
    expect(updates.observe({ ...input, truncated_runs: -1 })).toBeUndefined();
    expect(
      updates.observe({
        ...input,
        truncated_runs: 1,
        runs: [{ ...input.runs[0], run_id: "second" }],
      })?.details.results[0]?.workflow.graph.truncated,
    ).toBe(true);
  });

  it("bounds the run window while accepting newer runs and rejecting evicted run replays", () => {
    const updates = bound();
    const input = updated();
    const runs = Array.from({ length: 256 }, (_, index) => ({
      ...input.runs[0],
      run_id: `dag-${index}`,
    }));
    expect(
      updates.observe({ ...input, runs: [...runs, { ...runs[0], run_id: "extra" }] }),
    ).toBeUndefined();
    expect(updates.observe({ ...input, runs })?.details.results).toHaveLength(256);
    const extra = {
      ...input,
      runs: [{ ...runs[0], run_id: "extra", created_at: "2026-11-12T12:20:50.027Z" }],
    };
    expect(updates.observe(extra)?.details.results[0]?.taskRef).toBe("extra");
    expect(updates.observe(extra)).toBeUndefined();
    expect(updates.observe({ ...input, runs: [runs[0]] })).toBeUndefined();
    expect(updates.observe({ ...input, runs: [runs[255]] })).toBeUndefined();
  });

  it("does not apply journal mutations, activity or overflow notifications as graph state", () => {
    const updates = bound();
    updates.observe(snapshot());
    for (const name of ["omo.dag.event", "omo.dag.activity", "omo.dag.heartbeat"])
      expect(updates.observe({ type: "extension_event", name, data: snapshot() })).toBeUndefined();
    expect(
      updates.observe({
        schemaVersion: 1,
        runId,
        seq: 50,
        type: "dag.stream.overflow",
        recoverAfterSeq: 15,
      }),
    ).toBeUndefined();
    expect(updates.observe(snapshot())).toBeUndefined();
  });
});
