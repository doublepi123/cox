import {
  isListedThreadLineage,
  type NotificationEventKind,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { NotificationSubscriptionRepository } from "../persistence/NotificationSubscriptions.ts";
import { makeAgentNotificationDelivery } from "./AgentNotificationDelivery.ts";

interface Candidate {
  readonly threadId: ThreadId;
  readonly kind: NotificationEventKind;
  readonly identity: string;
}

const humanRequest = (request: OrchestrationV2RuntimeRequest): boolean => {
  switch (request.kind) {
    case "command":
    case "file-read":
    case "file-change":
    case "permission":
    case "mcp-elicitation":
    case "user_input":
      return request.status === "pending";
    case "dynamic_tool_call":
    case "auth_refresh":
      return false;
    default: {
      const exhaustive: never = request.kind;
      return exhaustive;
    }
  }
};

const active = (status: string) => ["preparing", "starting", "running", "waiting"].includes(status);

export class AgentAttentionNotifier extends Context.Service<
  AgentAttentionNotifier,
  { readonly start: Effect.Effect<void> }
>()("cox/notifications/AgentAttentionNotifier") {}

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const events = yield* EventSinkV2;
  const subscriptions = yield* NotificationSubscriptionRepository;
  const environment = yield* ServerEnvironment;
  const sql = yield* SqlClient.SqlClient;
  const deliver = yield* makeAgentNotificationDelivery;
  const scope = yield* Scope.Scope;

  const start = Effect.gen(function* () {
    const environmentId = yield* environment.getEnvironmentId;
    const queue = yield* Queue.sliding<Candidate>(128);
    const running = new Map<ThreadId, Set<RunId>>();
    const pending = new Map<ThreadId, Set<string>>();
    const snapshot = yield* sql.withTransaction(
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot();
        for (const thread of [...snapshot.threads, ...snapshot.archivedThreads]) {
          const records = yield* projections.getThreadRecords(
            thread.id,
            ["runs", "runtimeRequests", "turnItems"],
            { turnItemTypes: ["secret_request"] },
          );
          running.set(
            thread.id,
            new Set(records.runs.filter((run) => active(run.status)).map((run) => run.id)),
          );
          pending.set(
            thread.id,
            new Set([
              ...records.runtimeRequests.filter(humanRequest).map((request) => request.id),
              ...records.turnItems.flatMap((item) =>
                item.type === "secret_request" && item.secretStatus === "pending" ? [item.id] : [],
              ),
            ]),
          );
        }
        return snapshot;
      }),
    );

    const eligible = Effect.fnUntraced(function* (threadId: ThreadId) {
      const thread = yield* projections.getThreadShell(threadId);
      return thread !== null &&
        isListedThreadLineage(thread.lineage) &&
        thread.archivedAt === null &&
        thread.snoozedUntil == null
        ? thread
        : null;
    });
    const dispatch = Effect.fnUntraced(function* (candidate: Candidate) {
      const thread = yield* eligible(candidate.threadId);
      if (thread === null) return;
      if (candidate.kind !== "human_attention" && thread.activeRunId !== null) return;
      const now = DateTime.formatIso(yield* DateTime.now);
      const dedupeKey = `${encodeURIComponent(candidate.threadId)}:${candidate.kind}:${encodeURIComponent(candidate.identity)}`;
      if (
        !(yield* subscriptions.claimNotificationDedupeKey({ dedupeKey, threadId: thread.id, now }))
      )
        return;
      const threadPath = `/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`;
      yield* deliver({
        event: dedupeKey,
        kind: candidate.kind,
        threadId: thread.id,
        threadPath,
        title: thread.title,
        body: {
          human_attention: "Your agent needs your input.",
          turn_completed: "Your agent finished the turn.",
          turn_failed: "Your agent's turn failed.",
        }[candidate.kind],
        timestamp: now,
      });
    });
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap(dispatch),
          Effect.catch(() => Effect.logWarning("Agent notification dispatch failed")),
        ),
      ),
    );
    const observe = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
      const requests = pending.get(event.threadId) ?? new Set<string>();
      const runs = running.get(event.threadId) ?? new Set<RunId>();
      pending.set(event.threadId, requests);
      running.set(event.threadId, runs);
      let candidate: Candidate | undefined;
      switch (event.type) {
        case "runtime-request.updated": {
          const request = event.payload;
          const existed = requests.has(request.id);
          if (humanRequest(request)) {
            requests.add(request.id);
            if (!existed)
              candidate = {
                threadId: event.threadId,
                kind: "human_attention",
                identity: request.id,
              };
          } else requests.delete(request.id);
          break;
        }
        case "turn-item.updated": {
          const item = event.payload;
          if (item.type !== "secret_request") break;
          const existed = requests.has(item.id);
          if (item.secretStatus === "pending") {
            requests.add(item.id);
            if (!existed && item.nodeId !== null && item.runId !== null && runs.has(item.runId))
              candidate = { threadId: event.threadId, kind: "human_attention", identity: item.id };
          } else requests.delete(item.id);
          break;
        }
        case "run.created":
        case "run.updated": {
          const run = event.payload;
          const wasActive = runs.has(run.id);
          if (active(run.status)) runs.add(run.id);
          else runs.delete(run.id);
          if (
            wasActive &&
            (run.status === "completed" || run.status === "failed") &&
            runs.size === 0 &&
            run.delegatedTaskId === undefined
          ) {
            const thread = yield* eligible(event.threadId);
            if (
              thread !== null &&
              thread.activeRunId === null &&
              thread.latestRunStopRequested !== true
            )
              candidate = {
                threadId: event.threadId,
                kind: run.status === "completed" ? "turn_completed" : "turn_failed",
                identity: run.id,
              };
          }
          break;
        }
        case "thread.deleted":
          pending.delete(event.threadId);
          running.delete(event.threadId);
          break;
        default:
          break;
      }
      if (candidate !== undefined && (yield* eligible(event.threadId)) !== null)
        yield* Queue.offer(queue, candidate);
    });
    yield* Effect.forkScoped(
      events.stream({ afterSequence: snapshot.snapshotSequence }).pipe(
        Stream.runForEach((stored) =>
          observe(stored.event).pipe(
            Effect.catch(() =>
              Effect.logWarning("Agent notification projection read failed", {
                threadId: stored.event.threadId,
              }),
            ),
          ),
        ),
        Effect.catch(() => Effect.logWarning("Agent notification event stream failed")),
      ),
    );
  });
  return AgentAttentionNotifier.of({
    start: start.pipe(Effect.provideService(Scope.Scope, scope), Effect.orDie),
  });
});

export const layer = Layer.effect(AgentAttentionNotifier, make);
