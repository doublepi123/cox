import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveActiveSubagentInstances,
  deriveVisibleSubagentInstances,
  deriveWorkflowGroups,
  isWorkflowScriptMessage,
  projectedSubagentsToRuntime,
  resolveWorkflowOpening,
} from "./subagentRuntime.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

type ProjectedSubagent = Parameters<typeof projectedSubagentsToRuntime>[0][number];
type ProjectedSubagentInstance = Parameters<typeof deriveActiveSubagentInstances>[0][number];

function subagent(overrides: Partial<ProjectedSubagent> = {}): ProjectedSubagent {
  return {
    id: "coordinator",
    title: "probe",
    prompt: "export const meta = …",
    model: "claude-opus-5[1m]",
    status: "running" satisfies OrchestrationV2Subagent["status"],
    result: null,
    startedAt: at("2026-08-01T10:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-08-01T10:00:05.000Z"),
    ...overrides,
  };
}

const member = (
  overrides: Partial<OrchestrationV2SubagentWorkflow["agents"][number]> = {},
): OrchestrationV2SubagentWorkflow["agents"][number] => ({
  index: 1,
  label: "alpha:one",
  state: "running",
  phaseIndex: 1,
  phaseTitle: "Alpha",
  ...overrides,
});

const groupsOf = (subagents: ReadonlyArray<ProjectedSubagent>) =>
  deriveWorkflowGroups(projectedSubagentsToRuntime(subagents));

function instance(overrides: Partial<ProjectedSubagentInstance> = {}): ProjectedSubagentInstance {
  return {
    ...subagent(overrides),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("review"),
    origin: "app_owned",
    ...overrides,
  };
}

describe("deriveActiveSubagentInstances", () => {
  it("retains only queued, running and waiting instances with provider identity", () => {
    const statuses = [
      "idle",
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const;
    const active = deriveActiveSubagentInstances(
      statuses.map((status) => instance({ id: status, status })),
    );
    expect(active.map((agent) => agent.status)).toEqual(["pending", "running", "waiting"]);
    expect(active[0]).toMatchObject({
      driver: "codex",
      providerInstanceId: "review",
      origin: "app_owned",
    });
    expect(deriveActiveSubagentInstances([])).toEqual([]);
  });

  it("counts workflow workers instead of their coordinator and inherits the model", () => {
    const active = deriveActiveSubagentInstances([
      instance({
        workflow: {
          phases: [],
          agents: [
            member(),
            member({ index: 2, state: "queued" }),
            member({ index: 3, state: "completed" }),
          ],
        },
      }),
    ]);
    expect(active).toHaveLength(2);
    expect(active.map((agent) => agent.kind)).toEqual(["workflow_agent", "workflow_agent"]);
    expect(active.map((agent) => agent.model)).toEqual(["claude-opus-5[1m]", "claude-opus-5[1m]"]);
  });

  it("keeps an active coordinator without active workers and removes settled owners", () => {
    const workflow = { phases: [], agents: [member({ state: "completed" })] };
    expect(deriveActiveSubagentInstances([instance({ workflow })])[0]?.kind).toBe("workflow");
    expect(
      deriveActiveSubagentInstances([
        instance({ status: "completed", workflow: { phases: [], agents: [member()] } }),
      ]),
    ).toEqual([]);
  });
});

describe("deriveVisibleSubagentInstances", () => {
  const native = (overrides: Partial<ProjectedSubagentInstance> = {}) =>
    instance({
      driver: ProviderDriverKind.make("omo"),
      origin: "provider_native",
      childThreadId: null,
      ...overrides,
    });

  it("retains terminal OMO native tasks without changing active or app-owned visibility", () => {
    const statuses = [
      "idle",
      "pending",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ] as const;
    const sources = statuses.flatMap((status) => [
      instance({ id: `app-${status}`, status }),
      native({ id: `native-${status}`, status }),
      native({ id: `other-${status}`, driver: ProviderDriverKind.make("pi"), status }),
      native({ id: `omo-app-${status}`, origin: "app_owned", status }),
    ]);
    const visible = deriveVisibleSubagentInstances(sources);
    const active = deriveActiveSubagentInstances(sources);
    expect(visible.slice(0, active.length)).toEqual(active);
    expect(visible.slice(active.length).map((agent) => agent.id)).toEqual([
      "native-cancelled",
      "native-completed",
      "native-failed",
      "native-interrupted",
    ]);
    expect(visible.some((agent) => agent.status === "idle")).toBe(false);
    expect(deriveVisibleSubagentInstances([])).toEqual([]);
  });

  it("bounds only recent terminal native rows to the newest 20 without mutating sources", () => {
    const sources = [
      ...Array.from({ length: 25 }, (_, index) =>
        native({
          id: `settled-${index}`,
          status: "completed",
          completedAt: DateTime.makeUnsafe(Date.UTC(2026, 7, 1, 10, 0, index)),
        }),
      ),
      ...Array.from({ length: 24 }, (_, index) => native({ id: `active-${index}` })),
      instance({ id: "app-active" }),
    ];
    const sourceIds = sources.map((source) => source.id);
    const visible = deriveVisibleSubagentInstances(sources);
    expect(visible).toHaveLength(45);
    expect(visible.slice(0, 25).map((agent) => agent.id)).toEqual([
      ...Array.from({ length: 24 }, (_, index) => `active-${index}`),
      "app-active",
    ]);
    expect(visible.slice(25).map((agent) => agent.id)).toEqual(
      Array.from({ length: 20 }, (_, index) => `settled-${24 - index}`),
    );
    expect(sources.map((source) => source.id)).toEqual(sourceIds);
  });

  it("orders recent rows by completion or update time with a stable identity tiebreak", () => {
    const visible = deriveVisibleSubagentInstances([
      native({
        id: "old-completion",
        status: "completed",
        completedAt: at("2026-08-01T10:00:02.000Z"),
        updatedAt: at("2026-08-01T10:01:00.000Z"),
      }),
      native({ id: "updated-b", status: "cancelled" }),
      native({ id: "updated-a", status: "interrupted" }),
      native({
        id: "new-completion",
        status: "failed",
        completedAt: at("2026-08-01T10:00:07.000Z"),
      }),
    ]);
    expect(visible.map((agent) => agent.id)).toEqual([
      "new-completion",
      "updated-a",
      "updated-b",
      "old-completion",
    ]);
  });

  it("preserves native names, models, tasks, progress, results and reported failures", () => {
    const visible = deriveVisibleSubagentInstances([
      native({
        id: "explore",
        title: "explore",
        prompt: "Find all call sites\nand report paths unchanged.",
        progress: "Read packages/client-runtime",
        model: "cox/raw-model-name",
        status: "completed",
        result: "Found src/state/subagentRuntime.ts",
        completedAt: at("2026-08-01T10:00:07.000Z"),
      }),
      native({ id: "oracle", title: "oracle", status: "failed", result: "Native tool failed" }),
    ]);
    expect(visible[0]).toMatchObject({
      id: "explore",
      title: "explore",
      prompt: "Find all call sites\nand report paths unchanged.",
      progress: "Read packages/client-runtime",
      model: "cox/raw-model-name",
      driver: "omo",
      providerInstanceId: "review",
      origin: "provider_native",
      childThreadId: null,
      status: "completed",
      result: "Found src/state/subagentRuntime.ts",
      error: null,
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:00:07.000Z",
    });
    expect(visible[1]).toMatchObject({
      title: "oracle",
      status: "failed",
      error: "Native tool failed",
    });
  });

  it("keeps workflow workers instead of coordinators and bounds expanded terminal rows", () => {
    const visible = deriveVisibleSubagentInstances([
      native({
        id: "live-workflow",
        workflow: {
          phases: [],
          agents: [
            member({ prompt: "Review the active changes" }),
            member({ index: 2, state: "completed" }),
          ],
        },
      }),
      native({
        id: "settled-workflow",
        status: "completed",
        workflow: {
          phases: [],
          agents: Array.from({ length: 25 }, (_, index) =>
            member({ index, state: "completed", prompt: `Native task ${index}` }),
          ),
        },
      }),
    ]);
    expect(visible).toHaveLength(21);
    expect(visible.every((agent) => agent.kind === "workflow_agent")).toBe(true);
    expect(visible[0]).toMatchObject({
      id: "live-workflow:agent:1",
      prompt: "Review the active changes",
      status: "running",
    });
    expect(visible[1]).toMatchObject({
      id: "settled-workflow:agent:0",
      prompt: "Native task 0",
      status: "completed",
    });
  });
});

describe("projectedSubagentsToRuntime workflow expansion", () => {
  it.each([undefined, 1983254])(
    "retains cache reuse and duration %s without token usage",
    (durationMs) => {
      const [, cached, live] = projectedSubagentsToRuntime([
        subagent({
          workflow: {
            phases: [],
            agents: [
              member({
                index: 1,
                state: "completed",
                cached: true,
                reusedAt: 1793887167396,
                ...(durationMs === undefined ? {} : { durationMs }),
              }),
              member({ index: 2, startedAt: Date.UTC(2026, 7, 1, 10) }),
            ],
          },
        }),
      ]);
      expect(cached).toMatchObject({
        cached: true,
        durationMs,
        reusedAt: "2026-11-05T13:59:27.396Z",
        startedAt: null,
        completedAt: null,
        usage: null,
      });
      expect(live).toMatchObject({
        status: "running",
        startedAt: "2026-08-01T10:00:00.000Z",
        completedAt: null,
      });
      expect(live?.cached).toBeUndefined();
    },
  );

  it("uses a settled member's wall-clock completion separately from its execution duration", () => {
    const [, settled] = projectedSubagentsToRuntime([
      subagent({
        status: "completed",
        completedAt: at("2026-08-01T10:00:09.000Z"),
        workflow: {
          phases: [],
          agents: [
            member({
              state: "completed",
              model: "claude-opus-5[1m]",
              effort: "xhigh",
              speed: "standard",
              startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
              durationMs: 1500,
              completedAt: Date.UTC(2026, 7, 1, 10, 0, 4, 432),
              totalTokens: 71_141,
              toolCalls: 3,
              prompt: "Reply with exactly: A1",
              result: "A1",
            }),
          ],
        },
      }),
    ]);
    expect(settled?.status).toBe("completed");
    expect(settled?.completedAt).toBe("2026-08-01T10:00:04.432Z");
    expect(settled?.result).toBe("A1");
    expect(settled?.model).toBe("claude-opus-5[1m]");
    expect(settled?.effort).toBe("xhigh");
    expect(settled?.speed).toBe("standard");
    expect(settled?.progress).toBe("Reply with exactly: A1");
    expect(settled?.usage).toEqual({ totalTokens: 71_141, toolUses: 3, durationMs: 1500 });
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "settles unfinished members when the coordinator is %s",
    (status) => {
      const groups = groupsOf([
        subagent({
          status,
          completedAt: at("2026-08-01T10:00:09.000Z"),
          workflow: {
            phases: [],
            agents: [
              member(),
              member({ index: 2, state: "queued" }),
              member({
                index: 3,
                state: "completed",
                startedAt: Date.UTC(2026, 7, 1, 10, 0, 0),
                durationMs: 1500,
              }),
            ],
          },
        }),
      ]);
      expect(groups[0]?.workflow.status).toBe(status);
      const members = groups[0]?.phases.flatMap((phase) => phase.members);
      expect(members?.map((agent) => agent.status)).toEqual([status, status, "completed"]);
      expect(members?.map((agent) => agent.completedAt)).toEqual([
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:09.000Z",
        "2026-08-01T10:00:01.500Z",
      ]);
      expect(members?.[0]?.model).toBeNull();
      expect(members?.[0]?.effort).toBeNull();
      expect(members?.[0]?.speed).toBeUndefined();
    },
  );

  it("titles an untitled subagent from its prompt without splitting an emoji", () => {
    const [untitled] = projectedSubagentsToRuntime([
      subagent({ title: null, prompt: `${"a".repeat(76)}😀 and more work.` }),
    ]);
    expect(untitled?.title).toBe(`${"a".repeat(76)}...`);
  });
});

describe("deriveWorkflowGroups over a dynamic workflow", () => {
  it("groups members under their phases and counts the run", () => {
    const groups = groupsOf([
      subagent({
        workflow: {
          name: "probe-wf",
          phases: [
            { index: 1, title: "Alpha" },
            { index: 2, title: "Beta" },
          ],
          agents: [
            member({ state: "completed" }),
            member({ index: 2, label: "alpha:two", state: "failed" }),
            member({ index: 3, label: "beta:one", phaseIndex: 2, phaseTitle: "Beta" }),
            member({
              index: 4,
              label: "beta:two",
              phaseIndex: 2,
              phaseTitle: "Beta",
              state: "queued",
            }),
          ],
        },
      }),
    ]);
    const group = groups[0];
    expect(group?.phases.map((phase) => [phase.title, phase.state])).toEqual([
      ["Alpha", "done"],
      ["Beta", "running"],
    ]);
    expect(group?.phases.map((phase) => phase.settledCount)).toEqual([2, 0]);
    expect(group?.phases.flatMap((phase) => phase.members)).toHaveLength(4);
    expect(group?.unphasedMembers).toEqual([]);
  });

  it.each([false, true])("keeps a reported phase title, missing title first=%s", (missingFirst) => {
    const agents = [member({ phaseTitle: "Review" }), member({ index: 2, phaseTitle: undefined })];
    const groups = groupsOf([
      subagent({ workflow: { phases: [], agents: missingFirst ? agents.toReversed() : agents } }),
    ]);
    expect(groups[0]?.phases[0]?.title).toBe("Review");
  });

  it("keeps unphased members with their workflow and excludes unrelated agents", () => {
    const runtime = projectedSubagentsToRuntime([
      subagent({ id: "ordinary" }),
      subagent({
        id: "__proto__",
        workflow: {
          phases: [],
          agents: [member({ phaseIndex: undefined, phaseTitle: undefined })],
        },
      }),
      subagent({ id: "constructor", workflow: { phases: [], agents: [] } }),
      subagent({ id: "orphan", workflow: { phases: [], agents: [member()] } }),
    ]);
    const groups = deriveWorkflowGroups(runtime.filter((agent) => agent.id !== "orphan"));
    expect(groups.map((group) => group.workflow.id)).toEqual(["__proto__", "constructor"]);
    expect(groups[0]?.phases).toEqual([]);
    expect(groups[0]?.unphasedMembers.map((agent) => agent.title)).toEqual(["alpha:one"]);
    expect(groups[1]?.phases).toEqual([]);
    expect(groups[1]?.unphasedMembers).toEqual([]);
  });
});

describe("resolveWorkflowOpening", () => {
  const SCRIPT = '// probe\nexport const meta = { name: "probe-wf" };\nconst GROUPS = [];';
  const childThread = {
    id: ThreadId.make("child"),
    lineage: {
      parentThreadId: ThreadId.make("parent"),
      relationshipToParent: "subagent" as const,
      rootThreadId: ThreadId.make("parent"),
    },
    creationSource: "provider" as const,
  };
  const coordinator = (workflow?: OrchestrationV2SubagentWorkflow) => ({
    ...subagent({
      title: "Run the alpha workflow",
      childThreadId: "child",
      ...(workflow === undefined ? {} : { workflow }),
    }),
    driver: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude"),
  });
  const brief = (text: string, workflowScript?: boolean) => ({
    id: "message-1",
    role: "user",
    text,
    ...(workflowScript === undefined ? {} : { workflowScript }),
  });

  it("opens a marked thread with the coordinator's plan and members", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT, true)],
      parentSubagents: [
        coordinator({
          name: "probe-wf",
          phases: [{ index: 1, title: "Alpha" }],
          agents: [member({ childThreadId: ThreadId.make("member-1") })],
        }),
      ],
    });
    expect(opening).toMatchObject({
      messageId: "message-1",
      script: SCRIPT,
      name: "probe-wf",
      description: "Run the alpha workflow",
    });
    expect(
      opening?.group?.phases.map((phase) => ({
        title: phase.title,
        members: phase.members.map((agent) => [agent.title, agent.status, agent.childThreadId]),
      })),
    ).toEqual([{ title: "Alpha", members: [["alpha:one", "running", "member-1"]] }]);
  });

  it("recognizes an unmarked script before the parent loads", () => {
    const opening = resolveWorkflowOpening({
      thread: childThread,
      messages: [brief(SCRIPT)],
      parentSubagents: null,
    });
    expect(opening).toMatchObject({ script: SCRIPT, name: null, group: null });
  });

  it("leaves an ordinary subagent thread and other threads alone", () => {
    expect(
      resolveWorkflowOpening({
        thread: childThread,
        messages: [brief("Audit the last five commits.")],
        parentSubagents: [coordinator()],
      }),
    ).toBeNull();
    expect(
      resolveWorkflowOpening({
        thread: {
          ...childThread,
          lineage: { ...childThread.lineage, relationshipToParent: null, parentThreadId: null },
        },
        messages: [brief(SCRIPT)],
        parentSubagents: null,
      }),
    ).toBeNull();
    expect(isWorkflowScriptMessage({ role: "user", text: "Explain `export const meta`." })).toBe(
      false,
    );
    expect(isWorkflowScriptMessage({ role: "assistant", text: SCRIPT })).toBe(false);
  });
});
