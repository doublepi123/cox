import { describe, expect, it } from "vite-plus/test";
import { omoTodoSnapshot, OMO_TODO_BRIDGE_SOURCE } from "./todo.ts";

type NativeTask = { readonly content: string; readonly status: string };
const snapshot = (tasks: ReadonlyArray<NativeTask>, name = "Implementation") => ({
  sessionFile: "/fixture/root.jsonl",
  generation: "extension-1",
  hasList: true,
  revision: 1,
  phases: [{ name, tasks }],
});

describe("OMO Todo snapshots", () => {
  it("maps native statuses while retaining phase names and stable task identities", () => {
    const original = omoTodoSnapshot(
      snapshot([
        { content: "Inspect", status: "completed" },
        { content: "Implement", status: "in_progress" },
        { content: "Verify", status: "pending" },
        { content: "Abandoned", status: "abandoned" },
        { content: "Cancelled", status: "cancelled" },
      ]),
    )!;
    expect(original).toMatchObject({
      nativeThreadId: "/fixture/root.jsonl",
      generation: "extension-1",
      revision: 1,
    });
    expect(original.steps.map(({ text, status }) => ({ text, status }))).toEqual([
      { text: "Implementation: Inspect", status: "completed" },
      { text: "Implementation: Implement", status: "running" },
      { text: "Implementation: Verify", status: "pending" },
    ]);
    const reordered = omoTodoSnapshot(
      snapshot([
        { content: "Verify", status: "in_progress" },
        { content: "Implement", status: "completed" },
      ]),
    )!;
    expect(reordered.steps[0]?.id).toBe(original.steps[2]?.id);
    expect(reordered.steps[1]?.id).toBe(original.steps[1]?.id);
  });

  it("keeps duplicate and differently phased task names separate and permits an explicit clear", () => {
    const value = omoTodoSnapshot({
      ...snapshot([
        { content: "Verify", status: "pending" },
        { content: "Verify", status: "pending" },
      ]),
      phases: [
        ...snapshot([{ content: "Verify", status: "pending" }]).phases,
        ...snapshot(
          [
            { content: "Verify", status: "completed" },
            { content: "Verify", status: "pending" },
          ],
          "QA",
        ).phases,
      ],
    })!;
    expect(new Set(value.steps.map((step) => step.id)).size).toBe(3);
    expect(omoTodoSnapshot({ ...snapshot([]), phases: [] })?.steps).toEqual([]);
  });

  it("rejects malformed, oversized or unknown-state snapshots without dropping the previous plan", () => {
    for (const invalid of [
      undefined,
      {},
      { ...snapshot([]), sessionFile: "" },
      { ...snapshot([]), revision: -1 },
      { ...snapshot([]), revision: 0.5 },
      snapshot([{ content: "Inspect", status: "unknown" }]),
      snapshot([{ content: " ", status: "pending" }]),
      snapshot(Array.from({ length: 257 }, () => ({ content: "Inspect", status: "pending" }))),
      snapshot(Array.from({ length: 9 }, () => ({ content: "a".repeat(8192), status: "pending" }))),
      { ...snapshot([]), tasks: [{ task_id: "child", status: "running" }], phases: undefined },
    ])
      expect(omoTodoSnapshot(invalid)).toBeUndefined();
  });
});

interface Entry {
  readonly type: "custom" | "message";
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: unknown;
}

function bridge() {
  const handlers = new Map<string, (event: Record<string, unknown>, ctx: unknown) => unknown>();
  const rpc = new Map<string, (data: unknown) => unknown>();
  const updates: Array<{ name: string; data: unknown }> = [];
  const install = new Function("pi", "crypto", OMO_TODO_BRIDGE_SOURCE);
  install(
    {
      on: (name: string, handler: (event: Record<string, unknown>, ctx: unknown) => unknown) =>
        handlers.set(name, handler),
      rpc: {
        handle: (name: string, handler: (data: unknown) => unknown) => rpc.set(name, handler),
        emit: (name: string, data: unknown) => updates.push({ name, data }),
      },
    },
    { randomUUID: () => "extension-1" },
  );
  let entries: ReadonlyArray<Entry> = [];
  let sessionFile = "/fixture/root.jsonl";
  const ctx = { sessionManager: { getBranch: () => entries, getSessionFile: () => sessionFile } };
  return {
    handlers,
    rpc,
    updates,
    ctx,
    setEntries: (next: ReadonlyArray<Entry>) => {
      entries = next;
    },
    setSession: (next: string) => {
      sessionFile = next;
    },
  };
}

describe("OMO Todo extension bridge", () => {
  it("detaches snapshots from native entries and does not reinterpret malformed v2 state as legacy", () => {
    const test = bridge();
    const phases = [{ name: "Build", tasks: [{ content: "Implement", status: "pending" }] }];
    test.setEntries([
      { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases } },
      {
        type: "custom",
        customType: "senpi.todo-state",
        data: {
          schema: "v2",
          phases: [{ name: "Malformed", tasks: [null] }],
          todos: [{ content: "Not legacy", status: "completed" }],
        },
      },
    ]);
    test.handlers.get("session_start")!({}, test.ctx);
    const emitted = test.updates.at(-1)?.data;
    const read = test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/root.jsonl" });
    phases[0]!.tasks[0]!.status = "completed";
    phases.push({ name: "Later", tasks: [] });
    expect(emitted).toMatchObject({
      phases: [{ name: "Build", tasks: [{ content: "Implement", status: "pending" }] }],
      revision: 0,
    });
    expect(read).toMatchObject({
      phases: [{ name: "Build", tasks: [{ content: "Implement", status: "pending" }] }],
      revision: 0,
    });
    const refreshed = test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/root.jsonl" });
    expect(refreshed).toMatchObject({
      phases: [
        { name: "Build", tasks: [{ content: "Implement", status: "completed" }] },
        { name: "Later", tasks: [] },
      ],
      revision: 1,
    });
  });

  it("reads only structured branch state, publishes updates and exposes a session-scoped snapshot", () => {
    const test = bridge();
    test.setEntries([
      {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "- [x] Not a Todo state" }] },
      },
    ]);
    test.handlers.get("session_start")!({}, test.ctx);
    expect(test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/root.jsonl" })).toMatchObject({
      phases: [],
      revision: 0,
    });
    const phases = snapshot([{ content: "Implement", status: "in_progress" }]).phases;
    test.setEntries([
      { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases } },
    ]);
    test.handlers.get("tool_result")!({ toolName: "todo", isError: false }, test.ctx);
    expect(test.updates.at(-1)).toMatchObject({
      name: "cox.omo.todo.updated",
      data: { phases, revision: 1 },
    });
    expect(test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/root.jsonl" })).toMatchObject({
      phases,
      revision: 1,
    });
    expect(
      test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/child.jsonl" }),
    ).toBeUndefined();
    const count = test.updates.length;
    test.handlers.get("tool_result")!({ toolName: "task", isError: false }, test.ctx);
    test.handlers.get("tool_result")!({ toolName: "todo", isError: true }, test.ctx);
    expect(test.updates).toHaveLength(count);
  });

  it("restores branch snapshots after navigation, compaction and clears while ignoring malformed entries", () => {
    const test = bridge();
    const phases = snapshot([{ content: "Keep", status: "pending" }]).phases;
    test.setEntries([
      { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases } },
      {
        type: "custom",
        customType: "senpi.todo-state",
        data: { schema: "v2", phases: [{ name: "Bad", tasks: [null] }] },
      },
    ]);
    test.handlers.get("session_start")!({}, test.ctx);
    expect(test.updates.at(-1)?.data).toMatchObject({ phases, revision: 0 });
    test.setEntries([
      { type: "custom", customType: "senpi.todo-state", data: { schema: "v2", phases: [] } },
    ]);
    test.handlers.get("session_tree")!({}, test.ctx);
    expect(test.updates.at(-1)?.data).toMatchObject({ phases: [], revision: 1 });
    test.setEntries([
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todowrite",
          details: {
            todos: [
              { content: "Legacy", status: "blocked" },
              { content: "Removed", status: "cancelled" },
            ],
          },
        },
      },
    ]);
    test.handlers.get("session_compact")!({ accepted: false }, test.ctx);
    expect(test.updates.at(-1)?.data).toMatchObject({ phases: [], revision: 1 });
    test.handlers.get("session_compact")!({ accepted: true }, test.ctx);
    expect(test.updates.at(-1)?.data).toMatchObject({
      phases: [
        {
          name: "Tasks",
          tasks: [
            { content: "Legacy", status: "pending" },
            { content: "Removed", status: "cancelled" },
          ],
        },
      ],
      revision: 2,
    });
    test.setSession("/fixture/other.jsonl");
    expect(
      test.rpc.get("cox.omo.todo")!({ nativeThreadId: "/fixture/root.jsonl" }),
    ).toBeUndefined();
    test.handlers.get("session_start")!({}, test.ctx);
    expect(test.updates.at(-1)?.data).toMatchObject({
      sessionFile: "/fixture/other.jsonl",
      revision: 0,
    });
  });
});
