import { describe, expect, it } from "vite-plus/test";
import { OmoLifecycle, omoSessionState, omoTaskEvent, omoPermissionRequest } from "./runtime.ts";

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
});

describe("OMO native task snapshots", () => {
  it.each([
    "Permission required: edit\n\nFile: fixture",
    "st_worker: Permission required: edit\n\nFile: fixture",
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
