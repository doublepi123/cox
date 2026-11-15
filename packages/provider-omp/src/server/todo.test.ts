import { describe, expect, it } from "@effect/vitest";
import { ompTodoSnapshot } from "./todo.ts";

describe("OMP native todos", () => {
  it("projects native statuses with distinct stable duplicate task identities", () => {
    const snapshot = ompTodoSnapshot({
      sessionFile: "/omp/parent.jsonl",
      generation: "session-1",
      revision: 3,
      todoPhases: [
        {
          name: "Build",
          tasks: [
            { content: "Compile", status: "pending" },
            { content: "Compile", status: "in_progress" },
            { content: "Ship", status: "completed" },
            { content: "Dropped", status: "abandoned" },
          ],
        },
      ],
    });
    expect(snapshot).toMatchObject({
      nativeThreadId: "/omp/parent.jsonl",
      generation: "session-1",
      revision: 3,
      hasList: true,
      steps: [
        { text: "Build: Compile", status: "pending" },
        { text: "Build: Compile", status: "running" },
        { text: "Build: Ship", status: "completed" },
      ],
    });
    expect(new Set(snapshot?.steps.map((step) => step.id)).size).toBe(3);
  });

  it.each(["running", "cancelled", undefined])("rejects a nonnative task status %s", (status) => {
    expect(
      ompTodoSnapshot({
        sessionFile: "/parent",
        generation: "1",
        revision: 0,
        todoPhases: [{ name: "Tasks", tasks: [{ content: "Run", status }] }],
      }),
    ).toBeUndefined();
  });
});
