import type {
  DesktopComputerThreadEvent,
  OrchestrationV2DomainEvent,
  OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { DesktopComputerLink } from "./DesktopComputerLink.ts";

export const runStatusComputerState = (
  status: OrchestrationV2RunStatus,
): DesktopComputerThreadEvent["state"] | undefined => {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return undefined;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
};

export const computerThreadEvent = (
  event: OrchestrationV2DomainEvent,
): DesktopComputerThreadEvent["state"] | undefined => {
  switch (event.type) {
    case "run.updated":
      return event.payload.delegatedTaskId === undefined
        ? runStatusComputerState(event.payload.status)
        : undefined;
    case "turn-item.updated":
      return event.payload.type === "run_interrupt_request" ? "stopped" : undefined;
    case "thread.archived":
    case "thread.deleted":
      return "cancelled";
    default:
      return undefined;
  }
};

export class ComputerRunRelay extends Context.Service<
  ComputerRunRelay,
  { readonly start: Effect.Effect<void> }
>()("cox/computer/ComputerRunRelay") {}

export const make = Effect.gen(function* () {
  const events = yield* EventSinkV2;
  const link = yield* DesktopComputerLink;
  const scope = yield* Scope.Scope;
  const start = Effect.gen(function* () {
    const afterSequence = yield* events.latestSequence();
    yield* Effect.forkScoped(
      events.stream({ afterSequence }).pipe(
        Stream.runForEach((stored) =>
          Effect.gen(function* () {
            const threadId = stored.event.threadId;
            if (!link.isActive(threadId)) return;
            const state = computerThreadEvent(stored.event);
            if (state === undefined) return;
            yield* link.notifyThread(threadId, state);
            if (state !== "stopped") link.release(threadId);
          }),
        ),
        Effect.catch(() => Effect.logWarning("Computer control run relay stopped")),
      ),
    );
  });
  return ComputerRunRelay.of({
    start: start.pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.catch(() => Effect.logWarning("Computer control run relay could not start")),
    ),
  });
});

export const layer = Layer.effect(ComputerRunRelay, make);
