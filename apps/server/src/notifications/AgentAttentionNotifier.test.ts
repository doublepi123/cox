import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AuthSessionId, NodeId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { AgentAttentionNotifier } from "./AgentAttentionNotifier.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import {
  commit,
  layers,
  now,
  request,
  run,
  secret,
  syntheticAttention,
  thread,
  threadId,
} from "./AgentAttentionNotifier.testkit.ts";
import { keys, receiver } from "./notificationReceiver.testkit.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DateTime.toEpochMillis(now));
});
afterEach(() => vi.useRealTimers());

const initialize = (pushEndpoint: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, revoked_at)
    VALUES ('session', 'owner', '[]', 'browser-session-cookie', '2026-11-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', NULL)`;
    const subscriptions = yield* NotificationSubscriptionRepository;
    for (const suffix of ["/push", "/gone"]) {
      yield* subscriptions.upsertSubscription({
        sessionId: AuthSessionId.make("session"),
        endpoint: `${pushEndpoint}${suffix}`,
        endpointOrigin: pushEndpoint,
        keys,
        label: suffix,
        userAgent: null,
        createdAt: DateTime.formatIso(now),
      });
    }
    yield* (yield* ServerSecretStore).set(
      "notifications.webhook.aG9vaw.secret",
      new TextEncoder().encode("vault-secret"),
    );
    yield* commit({ type: "thread.created", payload: thread });
    yield* commit({ type: "run.created", payload: run("run-1") });
  });

it("delivers and decrypts each real attention or root outcome once and prunes HTTP 410 subscriptions", async () => {
  await using push = await receiver(true);
  await using hook = await receiver(false);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* initialize(push.endpoint);
        yield* (yield* AgentAttentionNotifier).start;
        const expected = [
          "human_attention",
          "human_attention",
          "human_attention",
          "turn_completed",
          "turn_failed",
        ];
        for (const event of [
          { type: "runtime-request.updated" as const, payload: request("ask_user_question") },
          {
            type: "runtime-request.updated" as const,
            payload: request("approval-dialog", "command"),
          },
          { type: "turn-item.updated" as const, payload: secret("request_secret") },
          { type: "run.updated" as const, payload: run("run-1", "completed") },
          { type: "run.created" as const, payload: run("run-2") },
          { type: "run.updated" as const, payload: run("run-2", "failed") },
        ]) {
          yield* commit(event);
          if (event.type === "run.created") continue;
          const [encrypted, webhook] = yield* Effect.promise(() =>
            Promise.all([push.next(), hook.next()]),
          );
          expect(encrypted).toEqual(webhook);
          expect(webhook).toMatchObject({
            kind: expected.shift(),
            threadPath: "/environment/attention-thread",
            deepLinkUrl: "/environment/attention-thread",
          });
        }
        const stored =
          yield* (yield* NotificationSubscriptionRepository).listDeliverableSubscriptions({
            now: DateTime.formatIso(now),
          });
        expect(stored.map((row) => [row.endpoint, row.lastDeliveredAt])).toEqual([
          [`${push.endpoint}/push`, DateTime.formatIso(now)],
        ]);
        expect(push.messages).toHaveLength(5);
        expect(hook.messages).toHaveLength(5);
      }).pipe(Effect.provide(layers(hook.endpoint))),
    ),
  );
});

it("silences startup state, synthetic attention, hidden threads, child work, cancellation and duplicate replay", async () => {
  await using push = await receiver(true);
  await using hook = await receiver(false);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* initialize(push.endpoint);
        yield* commit({ type: "runtime-request.updated", payload: request("already-pending") });
        yield* commit({ type: "turn-item.updated", payload: secret("old-secret") });
        yield* commit({ type: "run.created", payload: run("old-completed-2", "completed") });
        yield* (yield* AgentAttentionNotifier).start;
        yield* commit({ type: "runtime-request.updated", payload: request("already-pending") });
        yield* commit({ type: "turn-item.updated", payload: secret("old-secret") });
        yield* commit({ type: "run.updated", payload: run("old-completed-2", "completed") });
        for (const marker of [
          "stalled",
          "goal_blocked",
          "goal_paused",
          "interrupted_run",
          "question",
        ]) {
          expect(syntheticAttention(marker)).toEqual([]);
          yield* commit({
            type: "turn-item.updated",
            payload: {
              ...secret(marker),
              id: TurnItemId.make(marker),
              type: "system_notice",
              status: "completed",
              message: marker,
            },
          });
          yield* commit({ type: "run.updated", payload: run("run-1", "waiting") });
        }
        yield* commit({
          type: "run.created",
          payload: { ...run("internal-4"), delegatedTaskId: NodeId.make("child") },
        });
        yield* commit({
          type: "run.updated",
          payload: { ...run("internal-4", "completed"), delegatedTaskId: NodeId.make("child") },
        });
        for (const [name, fields] of [
          ["snoozed", { snoozedUntil: DateTime.makeUnsafe("2027-01-01T00:00:00.000Z") }],
          ["archived", { archivedAt: now }],
          ["scratch", { lineage: { ...thread.lineage, sideChat: true } }],
          [
            "child",
            {
              lineage: {
                rootThreadId: threadId,
                parentThreadId: threadId,
                relationshipToParent: "subagent" as const,
              },
            },
          ],
        ] as const) {
          const id = ThreadId.make(name);
          yield* commit({ type: "thread.created", payload: { ...thread, id, ...fields } }, id);
          yield* commit(
            { type: "run.created", payload: { ...run(`${name}-run`), threadId: id } },
            id,
          );
          expect((yield* (yield* ProjectionStoreV2).getThreadShell(id))?.id).toBe(id);
          yield* commit(
            { type: "runtime-request.updated", payload: request(`${name}-question`) },
            id,
          );
          yield* commit(
            { type: "run.updated", payload: { ...run(`${name}-run`, "completed"), threadId: id } },
            id,
          );
        }
        yield* commit({ type: "run.created", payload: run("run-6") });
        yield* commit({ type: "run.updated", payload: run("run-1", "completed") });
        yield* commit({ type: "run.updated", payload: run("run-6", "interrupted") });
        yield* commit({ type: "run.created", payload: run("cancelled-queue-5", "queued") });
        yield* commit({ type: "run.updated", payload: run("cancelled-queue-5", "cancelled") });
        yield* commit({ type: "run.updated", payload: run("run-1", "interrupted") });
        yield* commit({ type: "runtime-request.updated", payload: request("sentinel") });
        yield* Effect.promise(() => Promise.all([push.next(), hook.next()]));
        yield* commit({
          type: "runtime-request.updated",
          payload: { ...request("sentinel"), status: "resolved" },
        });
        yield* commit({ type: "runtime-request.updated", payload: request("sentinel") });
        yield* commit({ type: "run.created", payload: run("run-3") });
        yield* commit({ type: "run.updated", payload: run("run-3", "completed") });
        yield* Effect.promise(() => Promise.all([push.next(), hook.next()]));
        yield* commit({ type: "run.created", payload: run("run-3") });
        yield* commit({ type: "run.updated", payload: run("run-3", "completed") });
        yield* commit({ type: "runtime-request.updated", payload: request("final-sentinel") });
        yield* Effect.promise(() => Promise.all([push.next(), hook.next()]));
        expect(push.messages.map((message) => message.event)).toEqual([
          "attention-thread:human_attention:sentinel",
          "attention-thread:turn_completed:run-3",
          "attention-thread:human_attention:final-sentinel",
        ]);
        expect(hook.messages).toEqual(push.messages);
      }).pipe(Effect.provide(layers(hook.endpoint))),
    ),
  );
});

it("commits projections while a webhook holds its response for four seconds", async () => {
  await using push = await receiver(true);
  await using hook = await receiver(false);
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* initialize(push.endpoint);
        yield* (yield* AgentAttentionNotifier).start;
        const accepted = hook.delayNext();
        yield* commit({ type: "runtime-request.updated", payload: request("slow-receiver") });
        yield* Effect.promise(() => accepted);
        const resolution = commit({
          type: "runtime-request.updated",
          payload: { ...request("slow-receiver"), status: "resolved" },
        });
        if (process.env.COX_NOTIFICATION_QA === "1") {
          const [elapsed] = yield* Effect.timed(resolution);
          const elapsedMs = Duration.toMillis(elapsed);
          expect(elapsedMs).toBeLessThan(50);
          process.stdout.write(
            `QA on-disk projection commit during 4000ms webhook: ${elapsedMs.toFixed(3)}ms\n`,
          );
        } else yield* resolution;
        yield* commit({ type: "runtime-request.updated", payload: request("after-slow") });
        yield* Effect.promise(() => Promise.all([push.next(), hook.next()]));
        yield* Effect.promise(() => Promise.all([push.next(), hook.next()]));
        expect(hook.messages.map((message) => message.event)).toEqual([
          "attention-thread:human_attention:slow-receiver",
          "attention-thread:human_attention:after-slow",
        ]);
      }).pipe(Effect.provide(layers(hook.endpoint))),
    ),
  );
});
