import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OmpSubagents } from "./subagents.ts";

describe("OMP native subagents", () => {
  it.effect("retains a terminal child and pages its native transcript under the parent", () =>
    Effect.gen(function* () {
      const agents = new OmpSubagents();
      agents.observe(
        {
          type: "subagent_lifecycle",
          payload: {
            id: "child-1",
            agent: "worker",
            index: 0,
            status: "started",
            sessionFile: "/child",
          },
        },
        1000,
      );
      agents.observe(
        {
          type: "subagent_event",
          payload: {
            id: "child-1",
            event: {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Live answer" }],
              },
            },
          },
        },
        1500,
      );
      agents.observe(
        {
          type: "subagent_lifecycle",
          payload: {
            id: "child-1",
            agent: "worker",
            index: 0,
            status: "aborted",
            sessionFile: "/child",
          },
        },
        2000,
      );
      const cursors: unknown[] = [];
      yield* agents.refresh((record) =>
        Effect.sync(() => {
          if (record.type === "get_subagents") return { subagents: [] };
          cursors.push(record.fromByte);
          return record.fromByte === 0
            ? {
                sessionFile: "/child",
                fromByte: 0,
                nextByte: 100,
                reset: false,
                messages: [
                  { role: "assistant", content: [{ type: "text", text: "Native answer" }] },
                ],
              }
            : { sessionFile: "/child", fromByte: 100, nextByte: 100, reset: false, messages: [] };
        }),
      );
      assert.deepEqual(cursors, [0, 100]);
      expect(agents.snapshot("/parent").details).toMatchObject({
        results: [
          {
            nativeTaskId: "/parent/child-1",
            taskRef: "child-1",
            childSessionId: "/child",
            agent: "worker",
            task: "child-1",
            status: "cancelled",
            finished: true,
            stopReason: "aborted",
            messages: [{ role: "assistant", content: [{ type: "text", text: "Live answer" }] }],
            transcript: {
              entries: [{ index: 0, kind: "assistant", text: "Native answer" }],
              truncated: false,
            },
          },
        ],
      });
    }),
  );
});
