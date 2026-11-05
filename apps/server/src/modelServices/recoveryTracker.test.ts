import { expect, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeRecoveryTracker } from "./recoveryTracker.ts";
import { ModelServiceRequestFailure } from "./recovery.ts";

const input = (id: string) => ({
  threadId: ThreadId.make(id),
  runId: RunId.make(`run-${id}`),
  rootNodeId: NodeId.make(`node-${id}`),
  providerThread: {
    id: ProviderThreadId.make(`provider-${id}`),
    driver: ProviderDriverKind.make("codex"),
  },
});
const turn = (id: string): ProviderAdapterV2Event => ({
  type: "provider_turn.updated",
  driver: ProviderDriverKind.make("codex"),
  providerTurn: {
    id: ProviderTurnId.make(`turn-${id}`),
    providerThreadId: input(id).providerThread.id,
    nodeId: input(id).rootNodeId,
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal: 1,
    status: "running",
    startedAt: DateTime.makeUnsafe(0),
    completedAt: null,
  },
});
const progress = { phase: "hedging" as const, attempt: 2, maxAttempts: 12, delayMs: 0 };
const terminal = (
  id: string,
): Extract<ProviderAdapterV2Event, { type: "turn.terminal"; failure: null }> => ({
  type: "turn.terminal",
  driver: ProviderDriverKind.make("codex"),
  providerThreadId: input(id).providerThread.id,
  providerTurnId: ProviderTurnId.make(`turn-${id}`),
  runOrdinal: 1,
  status: "completed",
  failure: null,
  threadDisposition: "reusable",
});

it.effect("routes gateway progress to the correct turn and updates one stable item", () =>
  Effect.gen(function* () {
    const tracker = makeRecoveryTracker();
    const a = ProviderSessionId.make("session-a");
    const b = ProviderSessionId.make("session-b");
    const eventsA: ProviderAdapterV2Event[] = [];
    const eventsB: ProviderAdapterV2Event[] = [];
    yield* tracker.begin(a, input("a"), (event) =>
      Effect.sync(() => {
        eventsA.push(event);
      }),
    );
    yield* tracker.begin(b, input("b"), (event) =>
      Effect.sync(() => {
        eventsB.push(event);
      }),
    );
    const request = tracker.request(a, "request");
    yield* request.progress(progress);
    expect(eventsA).toHaveLength(0);
    yield* tracker.observe(a, turn("a"));
    yield* tracker.observe(b, turn("b"));
    yield* request.progress({ ...progress, phase: "recovered" });
    expect(eventsA).toHaveLength(2);
    expect(eventsB).toHaveLength(0);
    const items = eventsA.flatMap((event) =>
      event.type === "turn_item.updated" ? [event.turnItem] : [],
    );
    expect(items[0]?.id).toBe(items[1]?.id);
    expect(items[1]).toMatchObject({
      threadId: "a",
      providerTurnId: "turn-a",
      status: "completed",
    });
  }),
);

it.effect("shares exhausted request results with SDK retries and resets them for a new turn", () =>
  Effect.gen(function* () {
    const tracker = makeRecoveryTracker();
    const session = ProviderSessionId.make("session");
    yield* tracker.begin(session, input("a"), () => Effect.void);
    const request = tracker.request(session, "same-body");
    const error = new ModelServiceRequestFailure({
      detail: "Exhausted",
      status: 503,
      retryable: false,
    });
    yield* request.failed(error);
    expect(tracker.request(session, "same-body").failure).toBe(error);
    expect(tracker.request(session, "different-body").failure).toBeUndefined();
    yield* tracker.begin(session, input("b"), () => Effect.void);
    expect(yield* request.cancelled).toBe(false);
    expect(tracker.request(session, "same-body").failure).toBeUndefined();
    const next = tracker.request(session, "same-body");
    yield* tracker.cancel(session);
    expect(yield* next.cancelled).toBe(true);
    expect(yield* request.cancelled).toBe(true);
  }),
);

it.effect(
  "keeps background requests alive after root completion without reviving its progress",
  () =>
    Effect.gen(function* () {
      const tracker = makeRecoveryTracker();
      const session = ProviderSessionId.make("session");
      const events: ProviderAdapterV2Event[] = [];
      yield* tracker.begin(session, input("a"), (event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      );
      yield* tracker.observe(session, turn("a"));
      const first = tracker.request(session, "background-one");
      const second = tracker.request(session, "background-two");
      yield* first.progress(progress);
      yield* tracker.observe(session, terminal("a"));
      yield* first.progress({ ...progress, phase: "recovered" });
      yield* second.progress(progress);
      expect(events).toHaveLength(1);
      expect(yield* first.cancelled).toBe(false);
      expect(yield* second.cancelled).toBe(false);
      yield* tracker.cancel(session);
      expect(yield* first.cancelled).toBe(true);
      expect(yield* second.cancelled).toBe(true);
    }),
);

it.effect("ignores another turn's terminal on the same provider thread", () =>
  Effect.gen(function* () {
    const tracker = makeRecoveryTracker();
    const session = ProviderSessionId.make("session");
    const events: ProviderAdapterV2Event[] = [];
    yield* tracker.begin(session, input("a"), (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    yield* tracker.observe(session, turn("a"));
    const request = tracker.request(session, "background");
    yield* tracker.observe(session, {
      ...terminal("a"),
      providerTurnId: ProviderTurnId.make("other-turn"),
      status: "cancelled",
    });
    yield* request.progress(progress);
    expect(events).toHaveLength(1);
    expect(yield* request.cancelled).toBe(false);
  }),
);

it.effect(
  "closes requests from completed and current turns but keeps new sessions independent",
  () =>
    Effect.gen(function* () {
      const tracker = makeRecoveryTracker();
      const session = ProviderSessionId.make("session");
      const beforeTurn = tracker.request(session, "startup");
      yield* tracker.begin(session, input("a"), () => Effect.void);
      yield* tracker.observe(session, turn("a"));
      const old = tracker.request(session, "background");
      yield* tracker.observe(session, terminal("a"));
      yield* tracker.begin(session, input("b"), () => Effect.void);
      const next = tracker.request(session, "next");
      expect(yield* old.cancelled).toBe(false);
      yield* tracker.close(session);
      expect(yield* beforeTurn.cancelled).toBe(true);
      expect(yield* old.cancelled).toBe(true);
      expect(yield* next.cancelled).toBe(true);
      yield* tracker.begin(session, input("c"), () => Effect.void);
      expect(yield* tracker.request(session, "new-session").cancelled).toBe(false);
      expect(yield* old.cancelled).toBe(true);
    }),
);

it.effect("keeps old request progress and failures out of a new turn", () =>
  Effect.gen(function* () {
    const tracker = makeRecoveryTracker();
    const session = ProviderSessionId.make("session");
    yield* tracker.begin(session, input("a"), () => Effect.void);
    const old = tracker.request(session, "same-body");
    const events: ProviderAdapterV2Event[] = [];
    yield* tracker.begin(session, input("b"), (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    yield* tracker.observe(session, turn("b"));
    yield* old.progress(progress);
    yield* old.failed(
      new ModelServiceRequestFailure({ detail: "Old failure", status: 503, retryable: false }),
    );
    expect(events).toHaveLength(0);
    expect(tracker.request(session, "same-body").failure).toBeUndefined();
    expect(yield* old.cancelled).toBe(false);
    yield* tracker.cancel(session);
    yield* tracker.begin(session, input("c"), () => Effect.void);
    expect(yield* tracker.request(session, "same-body").cancelled).toBe(false);
    expect(yield* old.cancelled).toBe(true);
  }),
);

it.effect("keeps the status running while another request is still recovering", () =>
  Effect.gen(function* () {
    const tracker = makeRecoveryTracker();
    const session = ProviderSessionId.make("session");
    const events: ProviderAdapterV2Event[] = [];
    yield* tracker.begin(session, input("a"), (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    );
    yield* tracker.observe(session, turn("a"));
    const first = tracker.request(session, "first");
    const second = tracker.request(session, "second");
    yield* first.progress(progress);
    yield* second.progress(progress);
    yield* first.progress({ ...progress, phase: "recovered" });
    expect(events.at(-1)).toMatchObject({ turnItem: { status: "running" } });
    yield* second.progress({ ...progress, phase: "recovered" });
    expect(events.at(-1)).toMatchObject({ turnItem: { status: "completed" } });
  }),
);
