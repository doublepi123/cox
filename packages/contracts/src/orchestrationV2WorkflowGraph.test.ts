import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentJson,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2WorkflowGraph,
} from "./index.ts";

const decode = Schema.decodeUnknownSync(OrchestrationV2WorkflowGraph);
const decodeWorkflow = Schema.decodeUnknownSync(OrchestrationV2SubagentWorkflow);
const decodeSubagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const subagentCodecs = [OrchestrationV2SubagentJson, Schema.toCodecJson(OrchestrationV2Subagent)];
const encodeJson = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2WorkflowGraph));
const decodeJson = Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2WorkflowGraph));
const limits = ORCHESTRATION_V2_WORKFLOW_GRAPH_LIMITS;
const now = 1_794_485_250_026;

function graph() {
  return {
    schemaVersion: 1,
    runId: "dag-1",
    parentSessionId: "session-1",
    generation: 1,
    lastSeq: 15,
    name: "Native DAG",
    status: "completed",
    createdAt: now,
    updatedAt: now + 600,
    nodes: [
      {
        id: "inspect",
        label: "Inspect",
        prompt: "Inspect local fixture",
        state: "completed",
        attempt: 1,
        taskId: "st-first",
        model: "cox/main",
        childThreadId: "child-1",
        startedAt: now,
        completedAt: now + 100,
        progress: "Inspected fixture",
      },
      {
        id: "verify",
        label: "Verify",
        prompt: "Verify local fixture",
        state: "skipped",
        attempt: 0,
      },
    ],
    edges: [{ from: "inspect", to: "verify" }],
    waves: [
      { index: 0, nodeIds: ["inspect"] },
      { index: 1, nodeIds: ["verify"] },
    ],
    criticalPath: ["inspect", "verify"],
  };
}

describe("OrchestrationV2WorkflowGraph", () => {
  it("exports the schema and round-trips epoch timestamps and graph-only workflows", () => {
    const decoded = decode(graph());
    expect(decodeJson(encodeJson(decoded))).toEqual(decoded);
    expect(
      decodeWorkflow({
        name: decoded.name,
        runHandles: { runId: decoded.runId },
        phases: [],
        agents: [],
        graph: decoded,
      }).graph,
    ).toEqual(decoded);
    expect(decodeWorkflow({ phases: [], agents: [] }).graph).toBeUndefined();
  });

  it("preserves graph payloads through stored and wire subagent codecs", () => {
    const dag = decode(graph());
    const subagent = decodeSubagent({
      id: "dag-coordinator",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root",
      origin: "provider_native",
      createdBy: "agent",
      driver: "omo",
      providerInstanceId: "omo",
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: { driver: "omo", nativeId: dag.runId, strength: "strong" },
      prompt: dag.name,
      title: dag.name,
      model: null,
      status: "completed",
      result: "DAG completed",
      startedAt: DateTime.makeUnsafe(now),
      completedAt: DateTime.makeUnsafe(now + 600),
      updatedAt: DateTime.makeUnsafe(now + 600),
      workflow: { name: dag.name, phases: [], agents: [], graph: dag },
    });
    for (const codec of subagentCodecs) {
      const encode = Schema.encodeSync(codec);
      const decode = Schema.decodeUnknownSync(codec);
      const wire = JSON.parse(JSON.stringify(encode(subagent)));
      expect(decode(wire).workflow?.graph).toEqual(dag);
      expect(wire.workflow.graph.createdAt).toBe(now);
      expect(wire.workflow.graph.nodes[0].childThreadId).toBe("child-1");
    }
  });

  it.each(["pending", "running", "paused", "completed", "failed", "cancelled"])(
    "accepts run status %s without extending existing workflow states",
    (status) => expect(decode({ ...graph(), status }).status).toBe(status),
  );

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
  ])("accepts node state %s", (state) => {
    const input = graph();
    expect(
      decode({ ...input, nodes: input.nodes.map((node) => ({ ...node, state })) }).nodes[0]?.state,
    ).toBe(state);
  });

  it.each([
    ["schema version", { schemaVersion: 2 }],
    ["missing schema version", { schemaVersion: undefined }],
    ["run status", { status: "waiting" }],
    ["generation", { generation: -1 }],
    ["fractional generation", { generation: 0.5 }],
    ["unsafe sequence", { lastSeq: Number.MAX_SAFE_INTEGER + 1 }],
    ["nonfinite sequence", { lastSeq: Number.POSITIVE_INFINITY }],
    ["nonfinite time", { updatedAt: Number.NaN }],
    ["invalid date range", { updatedAt: 8_640_000_000_000_001 }],
    ["reversed timestamps", { updatedAt: now - 1 }],
    ["blank identity", { runId: " " }],
    ["long identity", { parentSessionId: "s".repeat(limits.idBytes + 1) }],
  ])("rejects invalid %s", (_name, fields) => {
    expect(() => decode({ ...graph(), ...fields })).toThrow();
  });

  it("rejects UTF-8 oversize text rather than counting only UTF-16 code units", () => {
    expect(() =>
      decode({ ...graph(), name: "界".repeat(Math.ceil(limits.labelBytes / 3)) }),
    ).toThrow();
    expect(() => decode({ ...graph(), name: "a".repeat(limits.labelBytes + 1) })).toThrow();
    expect(decode({ ...graph(), name: "a".repeat(limits.labelBytes) }).name).toHaveLength(
      limits.labelBytes,
    );
  });

  it("accepts the native node and wave maxima", () => {
    const nodes = Array.from({ length: limits.nodes }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      prompt: "",
      state: "pending",
      attempt: 0,
    }));
    const input = {
      ...graph(),
      nodes,
      edges: nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })),
      waves: nodes.map((node, index) => ({ index, nodeIds: [node.id] })),
      criticalPath: nodes.map((node) => node.id),
    };
    expect(decode(input).nodes).toHaveLength(256);
    expect(() => decode({ ...input, nodes: [...nodes, { ...nodes[0], id: "extra" }] })).toThrow();
    expect(() =>
      decode({ ...input, waves: [...input.waves, { index: 256, nodeIds: [] }] }),
    ).toThrow();
  });

  it("accepts exactly 2048 acyclic edges and rejects larger edge lists", () => {
    const nodes = Array.from({ length: 65 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      prompt: "",
      state: "pending",
      attempt: 0,
    }));
    const edges = nodes.flatMap((node, index) =>
      nodes.slice(index + 1).map((target) => ({ from: node.id, to: target.id })),
    );
    const input = { ...graph(), nodes, waves: [], criticalPath: [] };
    expect(decode({ ...input, edges: edges.slice(0, limits.edges) }).edges).toHaveLength(2_048);
    expect(() => decode({ ...input, edges: edges.slice(0, limits.edges + 1) })).toThrow();
  });

  it("bounds aggregate text even when each node is individually valid", () => {
    const nodes = Array.from({ length: 65 }, (_, index) => ({
      id: `node-${index}`,
      label: `Node ${index}`,
      prompt: "a".repeat(limits.promptBytes),
      state: "pending",
      attempt: 0,
    }));
    expect(() => decode({ ...graph(), nodes, edges: [], waves: [], criticalPath: [] })).toThrow();
  });

  it("rejects duplicate nodes, duplicate edges, foreign references and cycles", () => {
    const input = graph();
    const invalid = [
      { nodes: [input.nodes[0], input.nodes[0]] },
      { edges: [input.edges[0], input.edges[0]] },
      { edges: [{ from: "foreign", to: "inspect" }] },
      { edges: [{ from: "inspect", to: "foreign" }] },
      { edges: [{ from: "inspect", to: "inspect" }] },
      { edges: [...input.edges, { from: "verify", to: "inspect" }] },
      { waves: [{ index: 0, nodeIds: ["foreign"] }] },
      { waves: [{ index: 0, nodeIds: ["inspect", "inspect"] }] },
      { waves: [...input.waves, { index: 2, nodeIds: ["inspect"] }] },
      {
        waves: [
          { index: 0, nodeIds: [] },
          { index: 0, nodeIds: [] },
        ],
      },
      { criticalPath: ["foreign"] },
      { criticalPath: ["inspect", "inspect"] },
      { criticalPath: ["verify", "inspect"] },
    ];
    for (const fields of invalid) expect(() => decode({ ...input, ...fields })).toThrow();
  });

  it("validates optional node fields and failure details", () => {
    const input = graph();
    expect(
      decode({
        ...input,
        truncated: true,
        nodes: input.nodes.map((node) => ({
          ...node,
          lastError: { code: "lost_while_paused", message: "Native child was lost" },
        })),
      }).nodes[0]?.lastError,
    ).toEqual({ code: "lost_while_paused", message: "Native child was lost" });
    for (const fields of [
      { state: "unknown" },
      { attempt: -1 },
      { childThreadId: "x".repeat(limits.idBytes + 1) },
      { taskId: "x".repeat(limits.idBytes + 1) },
      { prompt: "x".repeat(limits.promptBytes + 1) },
      { model: "x".repeat(limits.modelBytes + 1) },
      { progress: "x".repeat(limits.progressBytes + 1) },
      { completedAt: now - 1 },
      { lastError: { code: "x".repeat(limits.errorCodeBytes + 1), message: "failed" } },
      { lastError: { code: "failed", message: "x".repeat(limits.errorMessageBytes + 1) } },
    ])
      expect(() =>
        decode({ ...input, nodes: [{ ...input.nodes[0], ...fields }, input.nodes[1]] }),
      ).toThrow();
  });
});
