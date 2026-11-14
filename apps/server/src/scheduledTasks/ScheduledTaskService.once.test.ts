import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
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

const decodeInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const projectId = "project:schedule-once";
const initialTime = "2026-11-10T12:00:00.000Z";
const initialRunAt = "2026-11-10T12:05:00.000Z";

const isoAt = (value: string) => DateTime.formatIso(DateTime.toUtc(DateTime.makeUnsafe(value)));

const baseInput = {
  title: "Once reminder",
  prompt: "Update the notes.",
  enabled: true,
  projectId,
  threadId: null,
  threadMode: "new_thread",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const makeHarness = Effect.fn("Once.test.makeHarness")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);
  const ticks = yield* Ref.make<ReadonlyMap<string, Effect.Effect<void>>>(new Map());
  let sequence = 0;
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(Scheduler.Scheduler, {
      register: Effect.fn("Once.test.register")(function* <E, R>(
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
        const message = input.initialMessage!;
        const messageId = message.messageId!;
        const threadId = ThreadId.make(`thread:${messageId}`);
        return Effect.gen(function* () {
          const now = DateTime.formatIso(yield* DateTime.now);
          sequence++;
          yield* sql`INSERT INTO orchestration_v2_projection_runs ${sql.insert({
            run_id: `run:${messageId}`,
            thread_id: threadId,
            ordinal: sequence,
            provider: "codex",
            status: "queued",
            requested_at: now,
            completed_at: null,
            payload_json: JSON.stringify({ userMessageId: messageId }),
          })}`;
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: messageId,
            thread_id: threadId,
            run_id: `run:${messageId}`,
            node_id: null,
            role: "user",
            streaming: 0,
            created_at: now,
            updated_at: now,
            payload_json: JSON.stringify({ scheduledTaskId: message.scheduledTaskId }),
          })}`;
          yield* Ref.update(calls, (previous) => [...previous, message.scheduledTaskId!]);
          return { threadId, resumed: false } as never;
        }).pipe(Effect.orDie);
      },
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(false),
    }),
    Layer.mock(SecretRequests.SecretRequests)({}),
  );
  const service = yield* ScheduledTaskService.ScheduledTaskService.pipe(
    Effect.provide(ScheduledTaskService.layer.pipe(Layer.provide(dependencies))),
  );
  const onceInput = (id: string, runAt: string) => ({
    ...baseInput,
    id,
    schedule: { type: "once" as const, runAt },
  });
  const save = (id: string, runAt: string) =>
    decodeInput(onceInput(id, runAt)).pipe(Effect.flatMap(service.upsert));
  const tick = Effect.gen(function* () {
    const tick = (yield* Ref.get(ticks)).get("scheduled-tasks");
    if (!tick) return yield* Effect.die("Missing scheduled-task source");
    yield* tick;
  });
  const listedTask = Effect.gen(function* () {
    return (yield* service.list()).tasks[0]!;
  });
  return { service, save, onceInput, tick, calls, sql, listedTask };
});

it.effect("a once task fires once, then stays disabled through re-enabling", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-fire", initialRunAt);
    assert.equal(task.nextRunAt, isoAt(initialRunAt));
    yield* TestClock.setTime(Date.parse(initialRunAt));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    const fired = yield* h.listedTask;
    assert.isFalse(fired.enabled);
    assert.isNull(fired.nextRunAt);
    assert.equal(fired.runCount, 1);
    assert.equal(fired.lastRunStatus, "succeeded");
    const reenabled = yield* h.service.setEnabled({ id: task.id, enabled: true });
    assert.isTrue(reenabled.task.enabled);
    assert.isNull(reenabled.task.nextRunAt);
    yield* TestClock.adjust("10 minutes");
    yield* h.tick;
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects a once runAt more than a minute in the past", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const rejected = yield* h.save("task:once-stale", "2026-11-10T11:58:59.000Z").pipe(Effect.flip);
    assert.equal(rejected.message, "A once schedule's runAt is too far in the past.");
    assert.isEmpty((yield* h.service.list()).tasks);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("rejects a once runAt that is not a date-time", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const rejected = yield* h.save("task:once-invalid", "tomorrow").pipe(Effect.flip);
    assert.equal(rejected.message, "A once schedule needs a valid runAt date-time.");
    assert.isEmpty((yield* h.service.list()).tasks);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("clamps a once runAt inside the tolerance to now and fires at the next poll", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-clamped", "2026-11-10T11:59:00.000Z");
    assert.equal(task.nextRunAt, isoAt(initialTime));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    const fired = yield* h.listedTask;
    assert.isFalse(fired.enabled);
    assert.isNull(fired.nextRunAt);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a manual run of an armed once task leaves it armed until runAt", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-manual", initialRunAt);
    const manual = yield* h.service.runNow({ id: task.id });
    assert.equal(manual.task.lastRunStatus, "succeeded");
    assert.equal(manual.task.runCount, 1);
    const between = yield* h.listedTask;
    assert.isTrue(between.enabled);
    assert.equal(between.nextRunAt, isoAt(initialRunAt));
    yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    yield* TestClock.setTime(Date.parse(initialRunAt));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 2);
    const fired = yield* h.listedTask;
    assert.isFalse(fired.enabled);
    assert.isNull(fired.nextRunAt);
    assert.equal(fired.runCount, 2);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a busy once occurrence is consumed and the task never re-arms", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-busy", initialRunAt);
    yield* h.service.runNow({ id: task.id });
    yield* TestClock.setTime(Date.parse(initialRunAt));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
    const skipped = yield* h.listedTask;
    assert.isFalse(skipped.enabled);
    assert.isNull(skipped.nextRunAt);
    assert.equal(skipped.runCount, 1);
    yield* TestClock.adjust("10 minutes");
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("editing a fired once task after its runAt passed keeps it inert", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-edit", initialRunAt);
    yield* TestClock.setTime(Date.parse(initialRunAt));
    yield* h.tick;
    yield* TestClock.adjust("10 minutes");
    const edited = yield* h.service.upsert(
      yield* decodeInput({
        ...h.onceInput(task.id, initialRunAt),
        enabled: false,
        title: "Edited",
      }),
    );
    assert.equal(edited.task.title, "Edited");
    assert.isFalse(edited.task.enabled);
    assert.isNull(edited.task.nextRunAt);
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("saving a new runAt re-arms a fired once task", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(initialTime));
    const h = yield* makeHarness();
    const { task } = yield* h.save("task:once-rearm", initialRunAt);
    yield* TestClock.setTime(Date.parse(initialRunAt));
    yield* h.tick;
    yield* h.sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
    yield* TestClock.adjust("10 minutes");
    const rearmed = yield* h.service.upsert(
      yield* decodeInput(h.onceInput(task.id, "2026-11-10T12:20:00.000Z")),
    );
    assert.isTrue(rearmed.task.enabled);
    assert.equal(rearmed.task.nextRunAt, isoAt("2026-11-10T12:20:00.000Z"));
    yield* TestClock.setTime(Date.parse("2026-11-10T12:20:00.000Z"));
    yield* h.tick;
    assert.lengthOf(yield* Ref.get(h.calls), 2);
    const fired = yield* h.listedTask;
    assert.isFalse(fired.enabled);
    assert.isNull(fired.nextRunAt);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
