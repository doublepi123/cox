import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { OmpSubagents } from "./subagents.ts";
import { ompRecord } from "./framing.ts";

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

  it.effect("serializes native times and preserves terminal status through stale snapshots", () =>
    Effect.gen(function* () {
      const agents = new OmpSubagents();
      agents.observe(
        {
          type: "subagent_lifecycle",
          payload: {
            id: "child-time",
            agent: "worker",
            index: 0,
            status: "started",
            sessionFile: "/child-time",
          },
        },
        Date.parse("2026-11-16T05:00:00.000Z"),
      );
      agents.observe(
        {
          type: "subagent_lifecycle",
          payload: {
            id: "child-time",
            agent: "worker",
            index: 0,
            status: "completed",
            sessionFile: "/child-time",
          },
        },
        Date.parse("2026-11-16T05:00:02.000Z"),
      );

      yield* agents.refresh((record) =>
        Effect.succeed(
          record.type === "get_subagents"
            ? {
                subagents: [
                  {
                    id: "child-time",
                    agent: "worker",
                    status: "completed",
                    sessionFile: "/child-time",
                    lastUpdate: Date.parse("2026-11-16T05:00:02.000Z"),
                  },
                ],
              }
            : {
                sessionFile: "/child-time",
                fromByte: record.fromByte,
                nextByte: record.fromByte,
                reset: false,
                messages: [],
              },
        ),
      );
      yield* agents.refresh((record) =>
        Effect.succeed(
          record.type === "get_subagents"
            ? {
                subagents: [
                  {
                    id: "child-time",
                    agent: "worker",
                    status: "running",
                    sessionFile: "/child-time",
                    lastUpdate: Date.parse("2026-11-16T05:00:01.000Z"),
                  },
                ],
              }
            : {
                sessionFile: "/child-time",
                fromByte: record.fromByte,
                nextByte: record.fromByte,
                reset: false,
                messages: [],
              },
        ),
      );
      expect(agents.snapshot("/native-parent").details).toMatchObject({
        results: [{ status: "completed", finished: true }],
      });
      const terminal = agents.snapshot("/native-parent");
      expect(terminal.details).toMatchObject({
        results: [
          {
            status: "completed",
            finished: true,
            startedAt: "2026-11-16T05:00:00.000Z",
            completedAt: "2026-11-16T05:00:02.000Z",
            updatedAt: "2026-11-16T05:00:02.000Z",
          },
        ],
      });
      agents.observe(
        {
          type: "subagent_lifecycle",
          payload: {
            id: "child-without-terminal-time",
            agent: "worker",
            index: 1,
            status: "started",
          },
        },
        Date.parse("2026-11-16T05:00:03.000Z"),
      );
      const adjacent = ompRecord(agents.snapshot("/native-parent").details).results;
      const running = Array.isArray(adjacent) ? adjacent[1] : undefined;
      expect(running).toMatchObject({
        startedAt: "2026-11-16T05:00:03.000Z",
        updatedAt: "2026-11-16T05:00:03.000Z",
      });
      expect(running).not.toHaveProperty("completedAt");
    }),
  );
});
