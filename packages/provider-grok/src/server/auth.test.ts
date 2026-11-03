import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ProviderAuthState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { makeGrokAuth, parseGrokDeviceLogin } from "./auth.ts";

const instanceId = ProviderInstanceId.make("grok-auth-test");
const url = "https://accounts.x.ai/oauth2/device?user_code=TEST-CODE";

describe("parseGrokDeviceLogin", () => {
  it("extracts the official CLI's colored device-code output", () => {
    expect(
      parseGrokDeviceLogin(
        `To sign in, open this URL in your browser:\n\n  ${url}\n\nConfirm this code in your browser:\n\n  \x1b[90mTEST-CODE\x1b[0m\nWaiting for authorization...`,
      ),
    ).toEqual({ url, userCode: "TEST-CODE" });
  });
  it("waits for complete chunks and ignores non-login output", () => {
    expect(parseGrokDeviceLogin("https://accounts.x.ai/oauth2/dev")).toBeUndefined();
    expect(
      parseGrokDeviceLogin("https://accounts.x.ai/oauth2/device?user_code=TEST-CO"),
    ).toBeUndefined();
    expect(parseGrokDeviceLogin("See https://docs.x.ai/build/overview")).toBeUndefined();
    expect(
      parseGrokDeviceLogin("https://user:pass@accounts.x.ai/oauth2/device?user_code=TEST-CODE"),
    ).toBeUndefined();
  });
  it("finds the device URL after unrelated documentation links", () => {
    expect(parseGrokDeviceLogin(`See https://docs.x.ai/build/overview\nOpen ${url}\n`)).toEqual({
      url,
      userCode: "TEST-CODE",
    });
  });
});

const harness = Effect.fn("GrokAuth.test.harness")(function* (
  options: {
    readonly apiKey?: string;
    readonly verified?: boolean;
    readonly enabled?: boolean;
  } = {},
) {
  const finish = yield* Deferred.make<void>();
  const interrupted = yield* Deferred.make<void>();
  const calls: ReadonlyArray<string>[] = [];
  let refreshed = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    calls.push(args);
    const login = args[0] === "login";
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: login
          ? Deferred.await(finish).pipe(
              Effect.as(ChildProcessSpawner.ExitCode(0)),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(login),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout:
          args[0] === "models"
            ? Stream.encodeText(
                Stream.make(
                  options.verified === false
                    ? "Not authenticated."
                    : "You are logged in with grok.com.",
                ),
              )
            : Stream.empty,
        stderr: login
          ? Stream.encodeText(
              Stream.make(
                "To sign in, open:\nhttps://accounts.x.ai/oauth2/",
                "device?user_code=TEST-CODE\nConfirm this code:\nTEST-CODE\n",
              ),
            )
          : Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  const controller = yield* makeGrokAuth({
    instanceId,
    enabled: options.enabled ?? true,
    environment: {
      HOME: "/isolated-home",
      ...(options.apiKey ? { XAI_API_KEY: options.apiKey } : {}),
    },
    canStart: Effect.succeed(true),
    onChanged: Effect.sync(() => {
      refreshed++;
    }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const phase = (value: ProviderAuthState["phase"], owner = "owner") =>
    controller.subscribe(owner).pipe(
      Stream.filter((state) => state.phase === value),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
  return { controller, phase, finish, interrupted, calls, refreshed: () => refreshed };
});

it.layer(NodeServices.layer)("Grok device login", (it) => {
  it.effect("waits for CLI verification, refreshes account state and supports sign-out", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      yield* h.controller.start("owner");
      const waiting = yield* h.phase("waiting");
      assert.deepEqual(waiting.interaction, {
        type: "deviceCode",
        id: "device-code",
        url,
        userCode: "TEST-CODE",
      });
      const other = yield* h.controller
        .subscribe("another-browser")
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow));
      assert.isNull(other.interaction);
      yield* Deferred.succeed(h.finish, undefined);
      yield* h.phase("succeeded");
      assert.strictEqual(h.refreshed(), 1);
      assert.deepEqual(h.calls, [["login", "--device-auth"], ["models"]]);
      yield* h.controller.logout(Effect.void);
      assert.deepEqual(h.calls.at(-1), ["logout"]);
      assert.strictEqual(h.refreshed(), 2);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts cancelled login without verifying it or refreshing credentials", () =>
    Effect.gen(function* () {
      const h = yield* harness();
      const started = yield* h.controller.start("owner");
      yield* h.phase("waiting");
      yield* h.controller.cancel("owner", started.flowId!);
      yield* Deferred.await(h.interrupted);
      yield* h.phase("cancelled");
      assert.deepEqual(h.calls, [["login", "--device-auth"]]);
      assert.strictEqual(h.refreshed(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("does not call an unverified login successful", () =>
    Effect.gen(function* () {
      const h = yield* harness({ verified: false });
      yield* h.controller.start("owner");
      yield* h.phase("waiting");
      yield* Deferred.succeed(h.finish, undefined);
      const failed = yield* h.phase("failed");
      assert.include(failed.message!, "did not confirm");
      assert.strictEqual(h.refreshed(), 0);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps API-key instances out of browser sign-in and sign-out", () =>
    Effect.gen(function* () {
      const h = yield* harness({ apiKey: "test-only" });
      yield* h.controller.start("owner");
      yield* h.phase("failed");
      const failure = yield* Effect.flip(h.controller.logout(Effect.void));
      assert.include(failure.detail, "XAI_API_KEY");
      assert.deepEqual(h.calls, []);
    }).pipe(Effect.scoped),
  );
});
