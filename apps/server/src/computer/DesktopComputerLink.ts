import {
  DesktopComputerAvailability,
  DesktopComputerReply,
  type DesktopComputerAction,
  type DesktopComputerPermission,
  type DesktopComputerThreadEvent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

export interface DesktopComputerChannel {
  readonly send: (message: unknown) => boolean;
  readonly subscribe: (listener: (message: unknown) => void) => () => void;
}

export interface DesktopComputerAvailabilityState {
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly missing: ReadonlyArray<DesktopComputerPermission>;
}

const unavailableState: DesktopComputerAvailabilityState = {
  enabled: false,
  ready: false,
  missing: [],
};

let currentAvailability = unavailableState;
const activeThreads = new Set<string>();
let requestSequence = 0;

export const computerAvailability = (): DesktopComputerAvailabilityState => currentAvailability;

export interface DesktopComputerCall {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly environmentId: string;
  readonly agent: string;
  readonly action: DesktopComputerAction;
}

export class DesktopComputerLinkError extends Schema.TaggedError<DesktopComputerLinkError>()(
  "DesktopComputerLinkError",
  { reason: Schema.Literals(["unavailable", "timeout", "disconnected"]) },
) {}

export interface DesktopComputerLinkShape {
  readonly availability: () => DesktopComputerAvailabilityState;
  readonly request: (
    call: DesktopComputerCall,
  ) => Effect.Effect<DesktopComputerReply, DesktopComputerLinkError>;
  readonly isActive: (threadId: string) => boolean;
  readonly release: (threadId: string) => void;
  readonly notifyThread: (
    threadId: string,
    state: DesktopComputerThreadEvent["state"],
  ) => Effect.Effect<void>;
}

export class DesktopComputerLink extends Context.Service<
  DesktopComputerLink,
  DesktopComputerLinkShape
>()("cox/computer/DesktopComputerLink") {}

const decodeAvailability = Schema.decodeUnknownOption(DesktopComputerAvailability);
const decodeReply = Schema.decodeUnknownOption(DesktopComputerReply);

export const makeLink = (
  channel: DesktopComputerChannel | undefined,
  timeoutMs = 120_000,
): Effect.Effect<DesktopComputerLinkShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const pending = new Map<string, (reply: Option.Option<DesktopComputerReply>) => void>();
    if (channel !== undefined) {
      const unsubscribe = channel.subscribe((message) => {
        const availability = decodeAvailability(message);
        if (availability._tag === "Some") {
          currentAvailability = {
            enabled: availability.value.enabled,
            ready: availability.value.ready,
            missing: availability.value.missing,
          };
          return;
        }
        const reply = decodeReply(message);
        if (reply._tag === "None") return;
        const resolve = pending.get(reply.value.id);
        if (resolve === undefined) return;
        pending.delete(reply.value.id);
        resolve(reply);
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
          currentAvailability = unavailableState;
          for (const resolve of pending.values()) resolve(Option.none());
          pending.clear();
        }),
      );
    }
    const request: DesktopComputerLinkShape["request"] = Effect.fn("DesktopComputerLink.request")(
      function* (call) {
        if (channel === undefined || !currentAvailability.enabled)
          return yield* new DesktopComputerLinkError({ reason: "unavailable" });
        requestSequence += 1;
        const id = `${process.pid}:${requestSequence}`;
        activeThreads.add(call.threadId);
        const reply = yield* Effect.callback<Option.Option<DesktopComputerReply>>((resume) => {
          pending.set(id, (value) => resume(Effect.succeed(value)));
          if (
            !channel.send({
              type: "cox:computer-request",
              id,
              threadId: call.threadId,
              threadTitle: call.threadTitle,
              environmentId: call.environmentId,
              agent: call.agent,
              action: call.action,
            })
          ) {
            pending.delete(id);
            resume(Effect.succeedNone);
          }
          return Effect.sync(() => {
            pending.delete(id);
          });
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () => Effect.fail(new DesktopComputerLinkError({ reason: "timeout" })),
          }),
        );
        if (Option.isNone(reply))
          return yield* new DesktopComputerLinkError({ reason: "disconnected" });
        return reply.value;
      },
    );
    const notifyThread: DesktopComputerLinkShape["notifyThread"] = (threadId, state) =>
      Effect.sync(() => {
        if (channel === undefined) return;
        channel.send({ type: "cox:computer-thread", threadId, state });
      });
    return {
      availability: () => currentAvailability,
      request,
      isActive: (threadId) => activeThreads.has(threadId),
      release: (threadId) => {
        activeThreads.delete(threadId);
      },
      notifyThread,
    };
  });

const processChannel = (): DesktopComputerChannel | undefined => {
  if (typeof process.send !== "function") return undefined;
  return {
    send: (message) => {
      if (!process.connected || process.send === undefined) return false;
      process.send(message);
      return true;
    },
    subscribe: (listener) => {
      process.on("message", listener);
      return () => {
        process.off("message", listener);
      };
    },
  };
};

export const layer = Layer.effect(
  DesktopComputerLink,
  Effect.suspend(() => makeLink(processChannel())),
);

export const layerChannel = (channel: DesktopComputerChannel | undefined, timeoutMs?: number) =>
  Layer.effect(DesktopComputerLink, makeLink(channel, timeoutMs));
