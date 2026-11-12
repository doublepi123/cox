import { describe, expect, it } from "vite-plus/test";

import { deriveCurrentTodoList } from "./threadTasks";

type Step = { readonly text: string; readonly status: "pending" | "running" | "completed" };

function todoList(id: string, runId: string | null, steps: ReadonlyArray<Step>, status = "active") {
  return {
    id,
    kind: "todo_list",
    runId,
    status,
    steps: steps.map((step, index) => ({ id: `${id}-${index}`, ...step })),
  };
}

function projection(input: {
  readonly runs: number;
  readonly plans: ReadonlyArray<unknown>;
}): Parameters<typeof deriveCurrentTodoList>[0] {
  return {
    runs: Array.from({ length: input.runs }, (_, index) => ({
      id: `run-${index + 1}`,
      ordinal: index + 1,
    })),
    plans: input.plans,
  } as never;
}

const done = (text: string): Step => ({ text, status: "completed" });
const running = (text: string): Step => ({ text, status: "running" });
const pending = (text: string): Step => ({ text, status: "pending" });

describe("deriveCurrentTodoList", () => {
  it("shows restored native snapshots immediately and clears stale projected lists without a new turn", () => {
    const stale = todoList("stale", "run-2", [running("Stale")]);
    const restored = todoList("restored", null, [pending("Restored")]);
    expect(deriveCurrentTodoList(projection({ runs: 2, plans: [stale, restored] }))?.id).toBe(
      "restored",
    );
    expect(
      deriveCurrentTodoList(
        projection({ runs: 2, plans: [stale, todoList("restored", null, [])] }),
      ),
    ).toBeNull();
    expect(
      deriveCurrentTodoList(
        projection({
          runs: 3,
          plans: [
            stale,
            { ...restored, status: "superseded" },
            todoList("latest", "run-3", [running("New")]),
          ],
        }),
      )?.id,
    ).toBe("latest");
  });
  it("ignores proposed plans, superseded lists and empty lists", () => {
    expect(
      deriveCurrentTodoList(
        projection({
          runs: 2,
          plans: [
            { id: "plan", kind: "proposed_plan", runId: "run-2", status: "active", markdown: "" },
            todoList("old", "run-2", [running("Old step")], "superseded"),
            todoList("empty", "run-2", []),
          ],
        }),
      ),
    ).toBeNull();
  });

  it("shows the newest list by run, even when an older one is listed later", () => {
    const current = deriveCurrentTodoList(
      projection({
        runs: 3,
        plans: [
          todoList("newest", "run-3", [done("Inspect"), running("Migrate"), pending("Verify")]),
          todoList("older", "run-1", [running("Earlier work")]),
        ],
      }),
    );
    expect(current?.id).toBe("newest");
  });

  it("keeps an unfinished list from an earlier run while later runs continue", () => {
    const current = deriveCurrentTodoList(
      projection({
        runs: 4,
        plans: [todoList("plan", "run-2", [done("Inspect"), pending("Ship")])],
      }),
    );
    expect(current?.id).toBe("plan");
  });

  it("keeps a finished list for its own run and hides it once a later run starts", () => {
    const plans = [todoList("plan", "run-2", [done("Inspect"), done("Ship")])];
    expect(deriveCurrentTodoList(projection({ runs: 2, plans }))?.id).toBe("plan");
    expect(deriveCurrentTodoList(projection({ runs: 3, plans }))).toBeNull();
  });
});
