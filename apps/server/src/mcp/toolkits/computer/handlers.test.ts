import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesktopComputerRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DesktopComputerLink from "../../../computer/DesktopComputerLink.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as ComputerHandlers from "./handlers.ts";
import { ComputerToolkit, computerToolsVisible } from "./tools.ts";

const fakeDesktop = () => {
  const listeners = new Set<(message: unknown) => void>();
  const sent: Array<unknown> = [];
  const channel: DesktopComputerLink.DesktopComputerChannel = {
    send: (message) => {
      sent.push(message);
      return true;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const deliver = (message: unknown) => {
    for (const listener of listeners) listener(message);
  };
  return { channel, sent, deliver };
};

const threadId = ThreadId.make("computer-thread");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("computer-environment"),
  requestNamespace: "computer-session",
  thread: {
    threadId,
    providerSessionId: "computer-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

const requests = (sent: ReadonlyArray<unknown>) =>
  sent.filter(
    (message): message is DesktopComputerRequest =>
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "cox:computer-request",
  );

it.effect("correlates interleaved replies and fails pending requests on timeout", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = fakeDesktop();
      const link = yield* DesktopComputerLink.makeLink(desktop.channel, 50);
      desktop.deliver({
        type: "cox:computer-availability",
        enabled: true,
        ready: true,
        missing: [],
      });
      const call = (text: string) =>
        link.request({
          threadId,
          threadTitle: "Notes",
          environmentId: "computer-environment",
          agent: "codex",
          action: { kind: "type", windowId: "w1", text },
        });
      const first = yield* Effect.forkChild(call("first"));
      const second = yield* Effect.forkChild(call("second"));
      yield* Effect.yieldNow;
      const [firstRequest, secondRequest] = requests(desktop.sent);
      desktop.deliver({
        type: "cox:computer-reply",
        id: secondRequest!.id,
        ok: true,
        result: "second-result",
      });
      desktop.deliver({
        type: "cox:computer-reply",
        id: firstRequest!.id,
        ok: true,
        result: "first-result",
      });
      expect(yield* Fiber.join(first)).toMatchObject({ result: "first-result" });
      expect(yield* Fiber.join(second)).toMatchObject({ result: "second-result" });
      const late = yield* Effect.forkChild(call("late").pipe(Effect.flip));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("100 millis");
      expect((yield* Fiber.join(late)).reason).toBe("timeout");
      expect(link.isActive(threadId)).toBe(true);
    }),
  ),
);

it.effect("refuses requests while the desktop reports computer control disabled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = fakeDesktop();
      const link = yield* DesktopComputerLink.makeLink(desktop.channel, 50);
      desktop.deliver({
        type: "cox:computer-availability",
        enabled: false,
        ready: false,
        missing: [],
      });
      const error = yield* link
        .request({
          threadId,
          threadTitle: "Notes",
          environmentId: "computer-environment",
          agent: "codex",
          action: { kind: "status" },
        })
        .pipe(Effect.flip);
      expect(error.reason).toBe("unavailable");
      expect(requests(desktop.sent)).toEqual([]);
      expect(computerToolsVisible()).toBe(false);
    }),
  ),
);

it.effect("tools carry the calling thread and report missing permissions with recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const desktop = fakeDesktop();
      const link = yield* DesktopComputerLink.makeLink(desktop.channel, 1_000);
      desktop.deliver({
        type: "cox:computer-availability",
        enabled: true,
        ready: false,
        missing: ["accessibility"],
      });
      expect(computerToolsVisible()).toBe(true);
      const dependencies = Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
        Layer.succeed(DesktopComputerLink.DesktopComputerLink, link),
        McpToolAccessTestkit.liveThreadsLayer,
      );
      const toolkit = yield* ComputerToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ComputerHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const typed = yield* Effect.forkChild(
        toolkit
          .handle("computer_type", { window_id: "w1", text: "cox line" })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
      );
      yield* Effect.yieldNow;
      const [request] = requests(desktop.sent);
      expect(request).toMatchObject({
        threadId,
        threadTitle: threadId,
        agent: "codex",
        action: { kind: "type", windowId: "w1", text: "cox line" },
      });
      desktop.deliver({
        type: "cox:computer-reply",
        id: request!.id,
        ok: false,
        error: { code: "permission", message: "Input was refused.", missing: ["accessibility"] },
      });
      const result = (yield* Fiber.join(typed)).at(-1)?.result;
      expect(result).toMatchObject({
        _tag: "DesktopComputerToolFailure",
        code: "permission",
        missing: ["accessibility"],
        recovery: ComputerHandlers.COMPUTER_RECOVERY,
      });
      expect(String((result as { readonly message: string }).message)).toContain("Accessibility");
    }),
  ),
);

it("describes computer control gaps in each platform's own terms", () => {
  const notReady = ComputerHandlers.replyFailure(
    {
      type: "cox:computer-reply",
      id: "r",
      ok: false,
      error: { code: "permission", message: "Not ready.", missing: ["input"] },
    },
    "win32",
  );
  expect(notReady.message).toContain("Not ready on this PC: Input and stop shortcut.");
  expect(notReady.message).not.toContain("macOS");
  expect(
    ComputerHandlers.replyFailure(
      {
        type: "cox:computer-reply",
        id: "r",
        ok: false,
        error: { code: "permission", message: "Not ready.", missing: ["input"] },
      },
      "darwin",
    ).message,
  ).toContain("Missing macOS permission: Input Monitoring.");
  const elevated = ComputerHandlers.replyFailure(
    {
      type: "cox:computer-reply",
      id: "r",
      ok: false,
      error: {
        code: "permission",
        message:
          "The target window belongs to an app running as administrator, and Windows blocks input to it from Cox.",
        recovery: "Run that app without administrator rights, or start Cox as administrator.",
      },
    },
    "win32",
  );
  expect(elevated).toMatchObject({
    code: "permission",
    recovery: "Run that app without administrator rights, or start Cox as administrator.",
  });
  expect(elevated.missing).toBeUndefined();
  expect(elevated.message).toContain("administrator");
});

it("passes engine state through and keeps Labs recovery to settings problems", () => {
  const stopped = ComputerHandlers.replyFailure({
    type: "cox:computer-reply",
    id: "r",
    ok: false,
    error: {
      code: "unavailable",
      message: "Computer control is turned on, but its engine is not running.",
      engine: "error",
      engineMessage: "Computer engine exited (9).",
      recovery: "Choose Re-check or restart Cox.",
    },
  });
  expect(stopped).toMatchObject({
    code: "unavailable",
    engine: "error",
    engineMessage: "Computer engine exited (9).",
    recovery: "Choose Re-check or restart Cox.",
  });
  const stale = ComputerHandlers.replyFailure({
    type: "cox:computer-reply",
    id: "r",
    ok: false,
    error: { code: "stale-frame", message: "frame f1 is stale" },
  });
  expect(stale.code).toBe("stale-frame");
  expect(stale.recovery).toBeUndefined();
  expect(
    ComputerHandlers.replyFailure({
      type: "cox:computer-reply",
      id: "r",
      ok: false,
      error: { code: "disabled", message: "Computer control is turned off." },
    }).recovery,
  ).toBe(ComputerHandlers.COMPUTER_RECOVERY);
});
