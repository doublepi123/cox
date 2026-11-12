import { describe, expect, it } from "vite-plus/test";
import { omoTaskTranscript, OMO_SUBAGENT_TRANSCRIPT_SOURCE } from "./subagents.ts";

describe("OMO native transcript snapshots", () => {
  it("validates ordered bounded structured entries and never interprets provider text", () => {
    const entries = [
      { index: 0, kind: "assistant", text: "<script>raw</script>" },
      { index: 1, kind: "tool", toolName: "write", text: "write", isError: false },
      { index: 2, kind: "error", text: "native failure" },
    ];
    expect(omoTaskTranscript({ entries, truncated: false })?.entries).toEqual(entries);
    for (const invalid of [
      undefined,
      {},
      { entries, truncated: "false" },
      { entries: [...entries, entries[0]], truncated: false },
      { entries: [{ index: 0, kind: "tool", text: "x" }], truncated: false },
      { entries: [{ index: 0, kind: "assistant", text: "x".repeat(48_001) }], truncated: false },
      {
        entries: Array.from({ length: 201 }, (_, index) => ({
          index,
          kind: "assistant",
          text: "x",
        })),
        truncated: false,
      },
    ])
      expect(omoTaskTranscript(invalid)).toBeUndefined();
  });

  it("reads only owned native tasks and retires access before a session switch", () => {
    const hooks = new Map<string, (_event: unknown, ctx: unknown) => void>();
    const requests = new Map<string, (value: unknown) => unknown>();
    const reads: string[] = [];
    const records: Record<string, { parent_session_id: string; child_session_id: string }> = {
      st_00000001: { parent_session_id: "parent", child_session_id: "child" },
      st_00000002: { parent_session_id: "other", child_session_id: "foreign" },
    };
    const pi = {
      cwd: "/fixture",
      on: (name: string, handler: (_event: unknown, ctx: unknown) => void) =>
        hooks.set(name, handler),
      rpc: {
        handle: (name: string, handler: (value: unknown) => unknown) => requests.set(name, handler),
      },
    };
    new Function("pi", "tasks", "config", OMO_SUBAGENT_TRANSCRIPT_SOURCE)(
      pi,
      {
        createTaskRecordStore: () => ({
          stateDir: "/fixture/tasks",
          load: (id: string) => records[id],
        }),
        defaultTranscriptReader: ({ taskId }: { taskId: string }) => {
          reads.push(taskId);
          return {
            entries: [
              { kind: "assistant", text: "result" },
              { kind: "tool", tool: "read", is_error: false },
            ],
            truncated: false,
          };
        },
      },
      { task: { state_dir: "/fixture/tasks" } },
    );
    const request = requests.get("cox.omo.task-transcripts")!;
    const data = {
      nativeThreadId: "/parent.jsonl",
      taskIds: ["st_00000001", "st_00000001", "st_00000002", "../../secret"],
    };
    expect(request(data)).toBeUndefined();
    hooks.get("session_start")!(
      {},
      { sessionManager: { getSessionFile: () => "/parent.jsonl", getSessionId: () => "parent" } },
    );
    expect(request(data)).toMatchObject({
      nativeThreadId: "/parent.jsonl",
      transcripts: [
        {
          taskId: "st_00000001",
          childSessionId: "child",
          entries: [
            { index: 0, kind: "assistant", text: "result" },
            { index: 1, kind: "tool", toolName: "read" },
          ],
        },
      ],
    });
    expect(reads).toEqual(["st_00000001"]);
    expect(request({ ...data, nativeThreadId: "/other.jsonl" })).toBeUndefined();
    expect(request({ ...data, taskIds: Array(33).fill("st_00000001") })).toBeUndefined();
    hooks.get("session_before_switch")!({}, {});
    expect(request(data)).toBeUndefined();
  });
});
