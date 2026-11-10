import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ScheduledTaskUpsertInput,
  type OrchestrationV2RunStatus,
  type ScheduledTask,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const projectId = ProjectId.make("project:single-flight");
const initialTime = "2026-11-10T12:00:00.000Z";

const makeHarness = Effect.fn("SingleFlight.test.makeHarness")(function* (options?: {
  readonly beforeDispatch?: Effect.Effect<void>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const calls = yield* Ref.make<
    ReadonlyArray<{ readonly taskId: string; readonly threadId: ThreadId }>
  >([]);
  const ticks = yield* Ref.make<ReadonlyMap<string, Effect.Effect<void>>>(new Map());
  let sequence = 0;
  const putRun = Effect.fn("SingleFlight.test.putRun")(function* (input: {
    readonly taskId: string;
    readonly threadId: ThreadId;
    readonly messageId: string;
    readonly status: OrchestrationV2RunStatus;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const runId = "run:" + input.messageId;
    sequence++;
    yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
      run_id: runId,
      thread_id: input.threadId,
      ordinal: sequence,
      provider: "codex",
      status: input.status,
      requested_at: now,
      completed_at: null,
      payload_json: JSON.stringify({ userMessageId: input.messageId }),
    })}`;
    yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
      message_id: input.messageId,
      thread_id: input.threadId,
      run_id: runId,
      node_id: null,
      role: "user",
      streaming: 0,
      created_at: now,
      updated_at: now,
      payload_json: JSON.stringify({ scheduledTaskId: input.taskId }),
    })}`;
    return runId;
  });
  const dispatched = Effect.fn("SingleFlight.test.dispatched")(function* (input: {
    readonly taskId: string;
    readonly threadId: ThreadId;
    readonly messageId: string;
  }) {
    if (options?.beforeDispatch) yield* options.beforeDispatch;
    yield* putRun({ ...input, status: "queued" });
    yield* Ref.update(calls, (previous) => [
      ...previous,
      { taskId: input.taskId, threadId: input.threadId },
    ]);
  });
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(Scheduler.Scheduler, {
      register: Effect.fn("SingleFlight.test.register")(function* <E, R>(
        name: string,
        tick: Effect.Effect<void, E, R>,
      ) {
        const context = yield* Effect.context<R>();
        yield* Ref.update(ticks, (previous) =>
          new Map(previous).set(name, tick.pipe(Effect.provideContext(context), Effect.orDie)),
        );
      }),
    }),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({
      launch: (input) => {
        const threadId = ThreadId.make("thread:" + input.initialMessage!.messageId);
        return dispatched({
          taskId: input.initialMessage!.scheduledTaskId!,
          messageId: input.initialMessage!.messageId!,
          threadId,
        }).pipe(Effect.orDie, Effect.as({ threadId, resumed: false } as never));
      },
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed({ ...liveThreadShell(threadId), projectId }),
      sendToThread: (input) =>
        dispatched({
          taskId: input.scheduledTaskId!,
          threadId: input.threadId,
          messageId: input.messageId,
        }).pipe(Effect.orDie, Effect.as({} as never)),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
  );
  const start = () =>
    ScheduledTaskService.ScheduledTaskService.pipe(
      Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))),
    );
  const service = yield* start();
  const save = (
    id: string,
    threadMode: "new_thread" | "continue" | "fresh_session" = "continue",
    schedule: ScheduledTask["schedule"] = { type: "interval", everyMs: 60_000 },
  ) =>
    decodeInput({
      id,
      title: "Single flight",
      prompt: "Check status",
      enabled: true,
      schedule,
      projectId,
      threadId: threadMode === "new_thread" ? null : "thread:bound",
      threadMode,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: "codex", model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
    }).pipe(Effect.flatMap(service.upsert));
  const tick = Effect.gen(function* () {
    const tick = (yield* Ref.get(ticks)).get("scheduled-tasks");
    if (!tick) return yield* Effect.die("Missing scheduled-task source");
    yield* tick;
  });
  return { service, start, save, tick, calls, putRun, sql };
});

it.effect.each(["queued", "preparing", "starting", "running", "waiting"] as const)(
  "skips subsequent automatic deliveries while the previous run is %s",
  (status) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialTime));
      const h = yield* makeHarness();
      const { task } = yield* h.save("task:busy-" + status);
      yield* h.service.runNow({ id: task.id });
      yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = ${status}`;
      const before = (yield* h.service.list()).tasks[0]!;
      for (let count = 1; count <= 3; count++) {
        yield* TestClock.adjust("1 minute");
        yield* h.tick;
        const after = (yield* h.service.list()).tasks[0]!;
        assert.equal(after.runCount, before.runCount);
        assert.equal(after.lastRunAt, before.lastRunAt);
        assert.equal(after.lastRunStatus, before.lastRunStatus);
        assert.equal(after.lastRunError, before.lastRunError);
        assert.equal(
          after.nextRunAt,
          DateTime.formatIso(
            DateTime.addDuration(DateTime.makeUnsafe(initialTime), (count + 1) * 60_000),
          ),
        );
      }
      assert.lengthOf(yield* Ref.get(h.calls), 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["completed", "failed", "cancelled", "interrupted", "rolled_back"] as const)(
  "allows the next due delivery once the old run is %s without catch-up deliveries",
  (status) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialTime));
      const h = yield* makeHarness();
      const { task } = yield* h.save("task:terminal-" + status);
      yield* h.service.runNow({ id: task.id });
      yield* TestClock.adjust("1 minute");
      yield* h.tick;
      yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = ${status}`;
      yield* h.tick;
      assert.lengthOf(yield* Ref.get(h.calls), 1);
      yield* TestClock.adjust("1 minute");
      yield* h.tick;
      assert.lengthOf(yield* Ref.get(h.calls), 2);
      assert.equal((yield* h.service.list()).tasks[0]!.runCount, 2);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each(["new_thread", "continue", "fresh_session"] as const)(
  "uses persisted outstanding messages across service restart for %s tasks",
  (threadMode) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialTime));
      const h = yield* makeHarness();
      const { task } = yield* h.save("task:restarted-" + threadMode, threadMode);
      yield* h.service.runNow({ id: task.id });
      const restarted = yield* h.start();
      yield* TestClock.adjust("1 minute");
      yield* h.tick;
      assert.lengthOf(yield* Ref.get(h.calls), 1);
      const result = yield* restarted.runNow({ id: task.id }).pipe(Effect.flip);
      assert.include(result.message, "Could not run schedule task.");
      assert.equal((yield* restarted.list()).tasks[0]!.runCount, 1);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("independent task ids on one thread do not block each other", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const first = yield* h.save("task:first");
    const second = yield* h.save("task:second");
    yield* h.service.runNow({ id: first.task.id });
    yield* TestClock.adjust("1 minute");
    yield* h.tick;
    assert.deepEqual(
      (yield* Ref.get(h.calls)).map((call) => call.taskId),
      [first.task.id, second.task.id],
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("an earlier unfinished delivery still blocks when a newer delivery is terminal", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:older-outstanding");
    yield* h.service.runNow({ id: task.id });
    yield* h.putRun({
      taskId: task.id,
      threadId: ThreadId.make("thread:bound"),
      messageId: "message:later-completed",
      status: "completed",
    });
    yield* TestClock.adjust("1 minute");
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.equal((yield* h.service.list()).tasks[0]!.runCount, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "ordinary active work on the destination thread does not suppress a task's first delivery",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(initialTime));
      const h = yield* makeHarness();
      const { task } = yield* h.save("task:ordinary-work");
      yield* h.putRun({
        taskId: "task:unrelated",
        threadId: ThreadId.make("thread:bound"),
        messageId: "message:ordinary",
        status: "running",
      });
      yield* h.sql`UPDATE orchestration_v2_projection_messages SET payload_json = '{}'`;
      yield* TestClock.adjust("1 minute");
      yield* h.tick;
      assert.lengthOf(yield* Ref.get(h.calls), 1);
      assert.equal((yield* Ref.get(h.calls))[0]!.taskId, task.id);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the old task's active run blocking after its destination is changed", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:rebound");
    yield* h.service.runNow({ id: task.id });
    yield* h.service.upsert({
      ...task,
      threadId: ThreadId.make("thread:other"),
      threadMode: "continue",
    });
    yield* TestClock.adjust("1 minute");
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("skips a busy fixed-time occurrence and continues at the next date", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:fixed-busy", "continue", {
      type: "fixed_time",
      timeOfDay: "12:01",
    });
    yield* h.service.runNow({ id: task.id });
    yield* TestClock.setTime(Date.parse((yield* h.service.list()).tasks[0]!.nextRunAt!));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.equal((yield* h.service.list()).tasks[0]!.runCount, 1);
    yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    yield* TestClock.setTime(Date.parse((yield* h.service.list()).tasks[0]!.nextRunAt!));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reserves a task while dispatch is in progress and does not disturb its run record", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const h = yield* makeHarness({
      beforeDispatch: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const { task } = yield* h.save("task:dispatching");
    const first = yield* h.service.runNow({ id: task.id }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const duplicate = yield* h.service.runNow({ id: task.id }).pipe(Effect.flip);
    assert.include(duplicate.message, "Could not run schedule task.");
    assert.equal((yield* h.service.list()).tasks[0]!.lastRunStatus, "running");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    assert.equal((yield* h.service.list()).tasks[0]!.lastRunStatus, "succeeded");
    assert.equal((yield* h.service.list()).tasks[0]!.runCount, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("shares the dispatch reservation across service instances", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const h = yield* makeHarness({
      beforeDispatch: Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      ),
    });
    const secondService = yield* h.start();
    const { task } = yield* h.save("task:shared-reservation");
    const first = yield* h.service.runNow({ id: task.id }).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    yield* secondService.runNow({ id: task.id }).pipe(Effect.flip);
    assert.equal((yield* h.service.list()).tasks[0]!.lastRunStatus, "running");
    assert.equal((yield* h.service.list()).tasks[0]!.runCount, 0);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
