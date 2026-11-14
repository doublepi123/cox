import { describe, expect, it } from "vite-plus/test";
import { OMO_SCHEDULE_BRIDGE_SOURCE } from "./schedule.ts";

const epoch = 1794614400000;
const ownTask = {
  scheduledTaskId: "scheduled-own",
  boundThreadId: "thread-own",
  title: "Reminder",
  prompt: "Check progress",
  enabled: true,
  schedule: { type: "once", runAt: "2026-11-14T00:10:00.000Z" },
  nextRunAt: "2026-11-14T00:10:00.000Z",
  lastRunStatus: null,
};
type Call = { readonly name: string; readonly args: Record<string, unknown> };
interface Tool {
  readonly execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
    readonly details: { readonly action: string; readonly jobs: ReadonlyArray<unknown> };
  }>;
}

function fixture(
  options: {
    readonly connected?: boolean;
    readonly error?: string;
    readonly tasks?: ReadonlyArray<typeof ownTask>;
  } = {},
) {
  const calls: Array<Call> = [];
  const tools: Array<Tool> = [];
  const install = new Function("pi", "bridge", "Type", "Date", OMO_SCHEDULE_BRIDGE_SOURCE);
  const schema = (value: unknown) => value;
  install(
    { registerTool: (tool: Tool) => tools.push(tool) },
    options.connected === false
      ? {}
      : {
          callTool: async (name: string, args: Record<string, unknown>) => {
            calls.push({ name, args });
            const data =
              name === "cox_thread_configure"
                ? { threadId: "thread-own" }
                : name === "list_scheduled_tasks"
                  ? {
                      tasks: options.tasks ?? [
                        ownTask,
                        { ...ownTask, scheduledTaskId: "foreign", boundThreadId: "thread-other" },
                      ],
                    }
                  : name === "schedule_task"
                    ? { ...ownTask, ...args }
                    : { scheduledTaskId: args.scheduledTaskId, deleted: true };
            return {
              content: [{ type: "text", text: options.error ?? "ok" }],
              structuredContent: { structuredContent: data },
              isError: options.error !== undefined,
            };
          },
        },
    {
      Object: schema,
      Union: schema,
      Literal: schema,
      Optional: schema,
      String: schema,
      Integer: schema,
    },
    class extends Date {
      static override now() {
        return epoch;
      }
    },
  );
  const execute = (params: Record<string, unknown>) => {
    const tool = tools[0];
    if (!tool) throw new Error("Schedule tool was not registered");
    return tool.execute("call", params);
  };
  return { tools, calls, execute };
}

describe("Cox scheduled prompts", () => {
  it("creates a thread-bound once task at the requested delay", async () => {
    const test = fixture();
    const result = await test.execute({
      action: "create",
      prompt: " Check progress ",
      delaySeconds: 600,
    });
    expect(test.calls).toEqual([
      { name: "cox_thread_configure", args: {} },
      { name: "list_scheduled_tasks", args: {} },
      {
        name: "schedule_task",
        args: {
          prompt: "Check progress",
          title: "Scheduled prompt: Check progress",
          schedule: { type: "once", runAt: "2026-11-14T00:10:00.000Z" },
          bindToCurrentThread: true,
        },
      },
    ]);
    expect(result.details).toMatchObject({
      action: "create",
      jobs: [{ scheduledTaskId: "scheduled-own" }],
    });
    expect(result.content[0]?.text).toContain("2026-11-14T00:10:00.000Z");
  });

  it("maps recurrence to a Cox interval and explains a different first-run delay", async () => {
    const test = fixture();
    const result = await test.execute({
      action: "create",
      prompt: "Repeat",
      delaySeconds: 600,
      everySeconds: 120,
    });
    expect(test.calls.at(-1)?.args.schedule).toEqual({ type: "interval", everyMs: 120000 });
    expect(result.content[0]?.text).toContain("first run comes after one interval");
  });

  it("accepts offset dates and clamps tolerated past dates to now", async () => {
    const test = fixture();
    await test.execute({ action: "create", prompt: "Now", at: "2026-11-14T08:59:30+09:00" });
    expect(test.calls.at(-1)?.args.schedule).toEqual({
      type: "once",
      runAt: "2026-11-14T00:00:00.000Z",
    });
  });

  it.each([
    [{ prompt: " " }, "non-empty prompt"],
    [{ prompt: "\u00e9".repeat(8193), delaySeconds: 1 }, "16384 bytes"],
    [{ delaySeconds: 1, at: "2026-11-14T00:00:00Z" }, "exactly one"],
    [{}, "exactly one"],
    [{ delaySeconds: -1 }, "non-negative integer"],
    [{ delaySeconds: 0.5 }, "non-negative integer"],
    [{ at: "2026-11-14T00:10:00" }, "UTC offset"],
    [{ at: "2026-99-99T00:00:00Z" }, "not a valid date-time"],
    [{ at: "2026-11-13T23:58:59Z" }, "in the past"],
    [{ delaySeconds: 366 * 86400 + 1 }, "366 days ahead"],
    [{ delaySeconds: 1, everySeconds: 59 }, "at least 60"],
    [{ delaySeconds: 1, everySeconds: 60.5 }, "at least 60"],
    [{ delaySeconds: 1, everySeconds: 366 * 86400 + 1 }, "at most"],
  ])("rejects invalid scheduling input %j before calling Cox", async (params, error) => {
    const test = fixture();
    await expect(test.execute({ action: "create", prompt: "Check", ...params })).rejects.toThrow(
      error,
    );
    expect(test.calls).toEqual([]);
  });

  it("lists only the caller's thread and caches its identity", async () => {
    const test = fixture();
    const result = await test.execute({ action: "list" });
    await test.execute({ action: "list" });
    expect(result.details.jobs).toEqual([ownTask]);
    expect(result.content[0]?.text).toContain("scheduled-own");
    expect(result.content[0]?.text).not.toContain("foreign");
    expect(test.calls.filter((call) => call.name === "cox_thread_configure")).toHaveLength(1);
  });

  it.each([
    { count: 50, boundThreadId: "thread-own", limit: "50 pending jobs" },
    { count: 1000, boundThreadId: "thread-other", limit: "1000 pending jobs" },
  ])("preserves the $count enabled-job capacity limit", async ({ count, boundThreadId, limit }) => {
    const test = fixture({
      tasks: Array.from({ length: count }, () => ({ ...ownTask, boundThreadId })),
    });
    await expect(
      test.execute({ action: "create", prompt: "Check", delaySeconds: 60 }),
    ).rejects.toThrow(limit);
    expect(test.calls.some((call) => call.name === "schedule_task")).toBe(false);
  });

  it("deletes a task owned by this thread", async () => {
    const test = fixture();
    const result = await test.execute({ action: "cancel", id: "scheduled-own" });
    expect(test.calls.at(-1)).toEqual({
      name: "delete_scheduled_task",
      args: { scheduledTaskId: "scheduled-own" },
    });
    expect(result.details).toEqual({ action: "cancel", jobs: [ownTask] });
  });

  it.each(["foreign", "unknown", ""])(
    "never deletes an inaccessible or missing id %j",
    async (id) => {
      const test = fixture();
      await expect(test.execute({ action: "cancel", id })).rejects.toThrow(
        id ? `No scheduled job ${id} in this session.` : "cancel needs the job id.",
      );
      expect(test.calls.filter((call) => call.name === "delete_scheduled_task")).toEqual([]);
    },
  );

  it("propagates Cox tool error text", async () => {
    const test = fixture({ error: "Cox schedule unavailable" });
    await expect(test.execute({ action: "list" })).rejects.toThrow("Cox schedule unavailable");
  });

  it("leaves the builtin registration alone without Cox credentials", () => {
    expect(fixture({ connected: false }).tools).toEqual([]);
  });
});
