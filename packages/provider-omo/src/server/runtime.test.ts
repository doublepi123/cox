import { describe, expect, it } from "vite-plus/test";
import {
  OmoLifecycle,
  OmoFailureRecovery,
  omoSessionState,
  omoTaskEvent,
  OmoTaskUpdates,
  omoPermissionRequest,
  omoStartupFailure,
  omoTaskIsQuiescent,
  OMO_WAIT_STATUS_KEY,
} from "./runtime.ts";

describe("OMO stranded provider failure", () => {
  const state = {
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    retryAttempt: 0,
    pendingMessageCount: 1,
    lifecycle: {
      role: "root",
      state: "running",
      runId: "run",
      restoring: false,
      persisted: true,
      holds: [],
      waitingOn: { children: 0, background: [], human: [] },
    },
  };
  const failed = () => {
    const recovery = new OmoFailureRecovery();
    recovery.observe({ type: "agent_start", runId: "run" });
    recovery.observe({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
    recovery.observe({ type: "agent_idle" });
    return recovery;
  };
  const deliveryState = {
    ...state,
    pendingMessageCount: 0,
    lifecycle: {
      ...state.lifecycle,
      state: "waiting_background",
      runActive: false,
      lastTurnEnd: { endedBy: "provider-error" },
      waitingOn: {
        children: 0,
        background: [{ source: "delivery:senpi-codemode:notification:completed", activeCount: 1 }],
        human: [],
      },
    },
  };
  it("requires both an assistant failure and a native idle boundary", () => {
    const recovery = new OmoFailureRecovery();
    expect(recovery.stranded(state)).toBe(false);
    recovery.observe({ type: "agent_start", runId: "run" });
    recovery.observe({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
    expect(recovery.stranded(state)).toBe(false);
    expect(recovery.observe({ type: "agent_idle" })).toBe(true);
    expect(recovery.stranded(state)).toBe(true);
  });
  it("does not recover streaming, compacting, bash, retrying or drained sessions", () => {
    for (const patch of [
      { isStreaming: true },
      { isCompacting: true },
      { isBashRunning: true },
      { retryAttempt: 1 },
      { pendingMessageCount: 0 },
    ])
      expect(failed().stranded({ ...state, ...patch })).toBe(false);
  });
  it("recovers completed notifications after the failed run becomes idle", () => {
    const recovery = new OmoFailureRecovery();
    recovery.observe({ type: "agent_start", runId: "run" });
    recovery.observe({ type: "message_end", message: { role: "assistant", stopReason: "error" } });
    expect(recovery.stranded(deliveryState)).toBe(false);
    recovery.observe({ type: "agent_idle" });
    expect(recovery.stranded(deliveryState)).toBe(true);
    expect(
      recovery.stranded({
        ...deliveryState,
        lifecycle: { ...deliveryState.lifecycle, runActive: undefined, lastTurnEnd: undefined },
      }),
    ).toBe(true);
    expect(
      recovery.stranded({
        ...deliveryState,
        pendingMessageCount: 1,
        lifecycle: { ...deliveryState.lifecycle, state: "running" },
      }),
    ).toBe(true);
    recovery.observe({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    expect(recovery.stranded(deliveryState)).toBe(false);
  });
  it("waits for real producers before recovering their queued notifications", () => {
    const background = deliveryState.lifecycle.waitingOn.background;
    expect(
      failed().stranded({
        ...deliveryState,
        lifecycle: {
          ...deliveryState.lifecycle,
          waitingOn: {
            ...deliveryState.lifecycle.waitingOn,
            background: [...background, { source: "senpi-codemode", activeCount: 1 }],
          },
        },
      }),
    ).toBe(false);
    expect(failed().stranded(deliveryState)).toBe(true);
  });
  it("preserves active runs, children, human waits and unknown background obligations", () => {
    const waits = deliveryState.lifecycle.waitingOn;
    for (const patch of [
      { runActive: true },
      { runId: "next" },
      { role: "child" },
      { persisted: false },
      { restoring: true },
      { activity: { kind: "model" } },
      { holds: [{ kind: "session_hold" }] },
      { waitingOn: { ...waits, children: 1 } },
      { waitingOn: { ...waits, human: [{ key: "answer" }] } },
      { waitingOn: { ...waits, background: [{ source: "memory", activeCount: 1 }] } },
      { waitingOn: { ...waits, background: [{ source: "delivery:", activeCount: 1 }] } },
      { waitingOn: { ...waits, background: [{}] } },
      { waitingOn: { ...waits, background: [] } },
      { state: "failed" },
    ])
      expect(
        failed().stranded({
          ...deliveryState,
          lifecycle: { ...deliveryState.lifecycle, ...patch },
        }),
      ).toBe(false);
    for (const patch of [
      { isStreaming: true },
      { isCompacting: true },
      { isBashRunning: true },
      { retryAttempt: 1 },
    ])
      expect(failed().stranded({ ...deliveryState, ...patch })).toBe(false);
  });
  it("preserves children, background work, human waits, holds and model activity", () => {
    for (const patch of [
      { waitingOn: { children: 1, background: [], human: [] } },
      { waitingOn: { children: 0, background: [{ source: "memory" }], human: [] } },
      { waitingOn: { children: 0, background: [], human: [{ key: "answer" }] } },
      { holds: [{ kind: "session_hold" }] },
      { activity: { kind: "model" } },
      { role: "child" },
      { runId: "next" },
      { persisted: false },
      { restoring: true },
      { state: "done" },
    ])
      expect(failed().stranded({ ...state, lifecycle: { ...state.lifecycle, ...patch } })).toBe(
        false,
      );
  });
  it("rechecks after background settlement and forgets failures on replacement and retry", () => {
    const recovery = failed();
    expect(recovery.observe({ type: "session_lifecycle" })).toBe(true);
    recovery.observe({ type: "auto_retry_start" });
    expect(recovery.stranded(state)).toBe(false);
    recovery.observe({ type: "agent_start", runId: "next" });
    recovery.observe({ type: "agent_idle" });
    expect(recovery.stranded(state)).toBe(false);
    recovery.reset();
    expect(recovery.stranded(state)).toBe(false);
  });
});

describe("OMO startup health", () => {
  it("does not fail startup for explicitly excluded tools", () => {
    expect(
      omoStartupFailure({
        ready: false,
        available: true,
        nativeTaskReady: false,
        coxOrchestrationReady: false,
        nativeTask: { required: true, registered: true, status: "excluded" },
        coxOrchestration: {
          required: true,
          connected: true,
          tools: [{ name: "mcp__cox__delegate_task", status: "excluded" }],
        },
      }),
    ).toBeUndefined();
  });

  it("does not accept the old task-only readiness signal", () => {
    expect(omoStartupFailure({ ready: true })).toContain("did not initialize");
  });

  it("reports missing connectivity, catalog entries and inactive tools", () => {
    const message = omoStartupFailure({
      available: false,
      nativeTaskReady: false,
      nativeTask: { required: true, status: "unregistered" },
      coxOrchestration: {
        required: true,
        connected: false,
        tools: [
          { name: "mcp__cox__orchestrator_capabilities", status: "missing-catalog" },
          { name: "mcp__cox__delegate_task", status: "inactive" },
          { name: "mcp__cox__task_status", status: "excluded" },
        ],
      },
    });
    expect(message).toContain("Native task: unregistered");
    expect(message).toContain("Cox MCP is not connected");
    expect(message).toContain("mcp__cox__orchestrator_capabilities: missing-catalog");
    expect(message).toContain("mcp__cox__delegate_task: inactive");
    expect(message).not.toContain("mcp__cox__task_status");
  });
});

const lifecycle = (state: string, seq: number, extra: Record<string, unknown> = {}) => ({
  type: "session_lifecycle",
  sessionId: "root",
  lifecycle: {
    role: "root",
    state,
    seq,
    epoch: 1,
    runId: "run",
    completionId: "root:1",
    persisted: true,
    restoring: false,
    ...extra,
  },
});

describe("OMO root work lifecycle", () => {
  it("does not settle a restoring or unpersisted root session", () => {
    const mapper = new OmoLifecycle();
    expect(mapper.observe(lifecycle("done", 1, { restoring: true }))).toEqual([]);
    expect(mapper.observe(lifecycle("done", 2, { persisted: false }))).toEqual([]);
    expect(mapper.observe(lifecycle("done", 3))).toHaveLength(1);
    expect(new OmoLifecycle(true).observe(lifecycle("done", 1, { persisted: false }))).toHaveLength(
      1,
    );
  });
  it("waits through agent settlement, children, background work and human input", () => {
    const mapper = new OmoLifecycle();
    mapper.observe({ type: "agent_start", runId: "run" });
    for (const event of [
      { type: "agent_settled" },
      { type: "agent_idle" },
      lifecycle("waiting_children", 1),
      lifecycle("waiting_background", 2),
      lifecycle("waiting_human", 3),
    ])
      expect(mapper.observe(event)).toEqual([]);
    expect(mapper.observe(lifecycle("done", 4))).toEqual([
      { type: "agent_settled", aborted: false },
    ]);
  });

  it("does not let child completion or a prior run complete the active root", () => {
    const mapper = new OmoLifecycle();
    mapper.observe({ type: "agent_start", runId: "run" });
    expect(
      mapper.observe({
        ...lifecycle("done", 1),
        sessionId: "child",
        lifecycle: { ...lifecycle("done", 1).lifecycle, role: "child" },
      }),
    ).toEqual([]);
    expect(mapper.observe(lifecycle("done", 2, { runId: "prior" }))).toEqual([]);
    expect(mapper.observe(lifecycle("done", 3))).toHaveLength(1);
  });

  it("deduplicates completion seals and ignores stale lifecycle snapshots", () => {
    const mapper = new OmoLifecycle();
    expect(mapper.observe(lifecycle("done", 4))).toHaveLength(1);
    expect(mapper.observe(lifecycle("failed", 3))).toEqual([]);
    expect(mapper.observe(lifecycle("done", 5))).toEqual([]);
    mapper.reset();
    expect(mapper.observe(lifecycle("done", 4))).toHaveLength(1);
  });
  it("binds restored and forked sessions instead of dropping every later completion", () => {
    const mapper = new OmoLifecycle();
    mapper.bind({ sessionId: "root" });
    expect(mapper.observe(lifecycle("done", 9))).toHaveLength(1);
    mapper.bind({ sessionId: "fork" });
    expect(mapper.observe({ ...lifecycle("done", 1), sessionId: "fork" })).toHaveLength(1);
    expect(mapper.observe(lifecycle("done", 10))).toEqual([]);
  });

  it("reports root failures and cancellation separately from successful completion", () => {
    expect(new OmoLifecycle().observe(lifecycle("failed", 1))).toMatchObject([
      { type: "message_end", message: { stopReason: "error" } },
      { type: "agent_settled", aborted: false },
    ]);
    expect(new OmoLifecycle().observe(lifecycle("cancelled", 1))).toEqual([
      { type: "agent_settled", aborted: true },
    ]);
  });

  it("keeps settlement probes busy until authoritative root completion", () => {
    for (const state of [
      "running",
      "waiting_children",
      "waiting_background",
      "waiting_human",
      "held",
      "paused",
    ])
      expect(omoSessionState({ isStreaming: false, lifecycle: { state } })).toMatchObject({
        isStreaming: true,
      });
    expect(
      omoSessionState({ isStreaming: false, lifecycle: { state: "done", persisted: true } }),
    ).toMatchObject({
      isStreaming: false,
    });
    expect(() => omoSessionState({ isStreaming: false })).toThrow("required session lifecycle");
  });

  it("settles an idle root whose only remaining human wait is a blocked goal", () => {
    const blockedGoal = { kind: "goal_blocked", requestId: "goal:1" };
    const blocked = (seq: number, extra: Record<string, unknown> = {}) =>
      lifecycle("waiting_human", seq, {
        completionId: undefined,
        runPaused: false,
        holds: [],
        waitingOn: { children: 0, background: [], human: [blockedGoal] },
        ...extra,
      });
    const started = () => {
      const mapper = new OmoLifecycle();
      mapper.observe({ type: "agent_start", runId: "run" });
      return mapper;
    };
    for (const extra of [
      { activity: { kind: "model" } },
      { runActive: true },
      { runPaused: true },
      { holds: [{ kind: "run_fence" }] },
      { waitingOn: { children: 1, background: [], human: [blockedGoal] } },
      {
        waitingOn: {
          children: 0,
          background: [{ source: "delivery:steer" }],
          human: [blockedGoal],
        },
      },
      { waitingOn: { children: 0, background: [{}], human: [blockedGoal] } },
      { waitingOn: { children: 0, background: [], human: [blockedGoal, { kind: "question" }] } },
      { waitingOn: { children: 0, background: [], human: [] } },
      { runId: "prior" },
    ]) {
      const mapper = started();
      expect(mapper.observe(blocked(1, extra))).toEqual([]);
      expect(mapper.observe({ type: "agent_idle" })).toEqual([]);
    }

    const mapper = started();
    expect(mapper.observe(blocked(1))).toEqual([]);
    expect(mapper.observe({ type: "agent_idle" })).toEqual([
      { type: "agent_settled", aborted: false },
    ]);
    expect(mapper.observe(blocked(2))).toEqual([]);

    const late = started();
    expect(late.observe({ type: "agent_idle" })).toEqual([]);
    expect(late.observe(blocked(1))).toEqual([{ type: "agent_settled", aborted: false }]);

    const retrying = started();
    expect(retrying.observe({ type: "agent_idle" })).toEqual([]);
    expect(retrying.observe({ type: "auto_retry_start" })).toEqual([{ type: "auto_retry_start" }]);
    expect(retrying.observe(blocked(1))).toEqual([]);

    const failed = started();
    failed.observe(blocked(1, { failure: { reason: "provider_error" } }));
    expect(failed.observe({ type: "agent_idle" })).toMatchObject([
      { type: "message_end", message: { stopReason: "error" } },
      { type: "agent_settled", aborted: false },
    ]);

    expect(omoSessionState({ isStreaming: false, lifecycle: blocked(1).lifecycle })).toMatchObject({
      isStreaming: false,
    });
    for (const state of [
      { isStreaming: true, lifecycle: blocked(1).lifecycle },
      { isStreaming: false, lifecycle: blocked(1, { activity: { kind: "tool" } }).lifecycle },
    ])
      expect(omoSessionState(state)).toMatchObject({ isStreaming: true });
  });

  it("settles an idle root that only waits on its own background monitors and shows the wait", () => {
    const monitors = { source: "terminal-monitors", activeCount: 1 };
    const waiting = (seq: number, extra: Record<string, unknown> = {}) =>
      lifecycle("waiting_background", seq, {
        completionId: undefined,
        runPaused: false,
        holds: [],
        waitingOn: { children: 0, background: [monitors], human: [] },
        ...extra,
      });
    const notice = {
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: OMO_WAIT_STATUS_KEY,
      statusText: expect.stringContaining("terminal monitors"),
    };
    const clear = {
      type: "extension_ui_request",
      method: "setStatus",
      statusKey: OMO_WAIT_STATUS_KEY,
    };
    const started = () => {
      const mapper = new OmoLifecycle();
      mapper.observe({ type: "agent_start", runId: "run" });
      return mapper;
    };

    const mapper = started();
    expect(mapper.observe(waiting(1))).toEqual([]);
    expect(mapper.observe({ type: "agent_idle" })).toEqual([
      notice,
      { type: "agent_settled", aborted: false },
    ]);
    expect(mapper.observe(waiting(2))).toEqual([]);
    expect(mapper.observe({ type: "agent_start", runId: "wake" })).toEqual([
      clear,
      { type: "agent_start", runId: "wake" },
    ]);

    const finished = started();
    finished.observe(waiting(1));
    finished.observe({ type: "agent_idle" });
    expect(
      finished.observe(
        lifecycle("done", 2, { waitingOn: { children: 0, background: [], human: [] } }),
      ),
    ).toEqual([clear]);

    const goal = started();
    goal.observe(
      waiting(1, {
        state: "waiting_human",
        waitingOn: {
          children: 0,
          background: [monitors],
          human: [{ kind: "goal_blocked", requestId: "goal:1" }],
        },
      }),
    );
    expect(goal.observe({ type: "agent_idle" })).toEqual([
      notice,
      { type: "agent_settled", aborted: false },
    ]);

    const quiet = started();
    quiet.observe(
      waiting(1, {
        waitingOn: { children: 0, background: [{ source: "cox-memory:1:2" }], human: [] },
      }),
    );
    expect(quiet.observe({ type: "agent_idle" })).toEqual([
      { type: "agent_settled", aborted: false },
    ]);

    for (const extra of [
      { waitingOn: { children: 1, background: [monitors], human: [] } },
      { activity: { kind: "tool" } },
      { holds: [{ kind: "run_fence" }] },
    ]) {
      const busy = started();
      busy.observe(waiting(1, extra));
      expect(busy.observe({ type: "agent_idle" })).toEqual([]);
    }

    expect(omoSessionState({ isStreaming: false, lifecycle: waiting(1).lifecycle })).toMatchObject({
      isStreaming: false,
    });
    expect(omoSessionState({ isStreaming: true, lifecycle: waiting(1).lifecycle })).toMatchObject({
      isStreaming: true,
    });
  });
});

describe("OMO native task snapshots", () => {
  it("preserves paused native tasks on Stop while refusing live or unknown states", () => {
    for (const status of ["completed", "error", "cancelled", "interrupted", "lost", "paused"])
      expect(omoTaskIsQuiescent({ status })).toBe(true);
    for (const status of ["running", "pending", "unknown", undefined])
      expect(omoTaskIsQuiescent({ status })).toBe(false);
  });
  it("binds snapshots to the active native session, resets on switch and rejects late foreign events", () => {
    const updates = new OmoTaskUpdates();
    const snapshot = {
      parent_session_id: "parent",
      tasks: [{ task_id: "st_1", status: "running" }],
    };
    expect(updates.observe(snapshot)).toBeUndefined();
    updates.bind({ sessionId: "parent", sessionFile: "/parent.jsonl" });
    expect(updates.observe(snapshot)).toMatchObject({
      type: "t3.native_subagents",
      nativeThreadId: "/parent.jsonl",
    });
    expect(updates.observe({ ...snapshot, parent_session_id: "other" })).toBeUndefined();
    updates.reset();
    expect(updates.observe(snapshot)).toBeUndefined();
    updates.bind({ sessionId: "other", sessionFile: "/other.jsonl" });
    expect(updates.observe(snapshot)).toBeUndefined();
  });

  it("reports actual effective models, native status and completion times without restarting tasks", () => {
    expect(
      omoTaskEvent(
        {
          parent_session_id: "p",
          tasks: [
            {
              task_id: "a",
              agent_type: "atlas",
              status: "pending",
              model: "requested",
              effective_model: { display: "actual" },
              created_at: "2026-11-12T00:00:00Z",
              updated_at: "2026-11-12T00:01:00Z",
            },
            { task_id: "e", agent_type: "explore", status: "paused" },
            {
              task_id: "o",
              agent_type: "oracle",
              status: "running",
              awaiting_input: { reason: "permission" },
            },
            { task_id: "c", status: "cancelled", updated_at: "2026-11-12T00:02:00Z" },
            { task_id: "x", status: "unknown" },
          ],
        },
        "/parent.jsonl",
      ),
    ).toMatchObject({
      nativeThreadId: "/parent.jsonl",
      details: {
        results: [
          { agent: "atlas", model: "actual", status: "pending", startedAt: "2026-11-12T00:00:00Z" },
          { agent: "explore", status: "waiting" },
          { agent: "oracle", status: "waiting" },
          { status: "cancelled", completedAt: "2026-11-12T00:02:00Z" },
        ],
      },
    });
  });
  it.each([
    "Permission required: edit\n\nFile: fixture",
    "st_worker: Permission required: edit\n\nFile: fixture",
    "atlas: Permission required: edit\n\nFile: fixture",
    "Custom: verifier: Permission required: edit\n\nFile: fixture",
  ])("maps native approval to Cox while preserving the tool call: %s", (title) => {
    expect(
      omoPermissionRequest({
        type: "extension_ui_request",
        method: "select",
        id: "approval",
        title,
        toolCallId: "call",
        options: ["Allow once", "Allow always", "Deny"],
      }),
    ).toMatchObject({
      method: "confirm",
      title: "Allow edit?",
      message: title,
      toolCallId: "call",
    });
    expect(
      omoPermissionRequest({
        type: "extension_ui_request",
        method: "select",
        id: "question",
        title: "Choose a file",
        options: ["Allow once", "Deny"],
      }),
    ).toBeUndefined();
  });
  it("preserves stable task identity, outcomes and model assignments", () => {
    const translated = omoTaskEvent({
      parent_session_id: "parent",
      tasks: [
        {
          task_id: "worker",
          name: "worker",
          agent_type: "explore",
          description: "Explore",
          model: "cox/exact/id",
          status: "completed",
          final_response: "result",
        },
        { task_id: "failed", status: "lost", error_message: "runner lost" },
        { task_id: "cancelled", status: "cancelled" },
      ],
    });
    expect(translated).toMatchObject({
      type: "t3.native_subagents",
      details: {
        results: [
          {
            nativeTaskId: "parent/worker",
            taskRef: "worker",
            agent: "explore",
            model: "cox/exact/id",
            finished: true,
            messages: [{ content: [{ text: "result" }] }],
          },
          {
            nativeTaskId: "parent/failed",
            stopReason: "error",
            finished: true,
            errorMessage: "runner lost",
          },
          { nativeTaskId: "parent/cancelled", stopReason: "aborted", finished: true },
        ],
      },
    });
  });

  it("keeps live progress running and drops malformed task entries", () => {
    expect(
      omoTaskEvent({
        tasks: [
          {
            task_id: "worker",
            status: "running",
            live_progress: { last_assistant_line: "checking" },
          },
          null,
          { task_id: 1 },
        ],
      }),
    ).toMatchObject({
      details: { results: [{ finished: false, messages: [{ content: [{ text: "checking" }] }] }] },
    });
    expect(omoTaskEvent({})).toBeUndefined();
  });
});
