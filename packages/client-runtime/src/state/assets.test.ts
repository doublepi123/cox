import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlResult,
  type AssetResource,
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { resolveMediaSource } from "../mediaSource.ts";
import type * as RpcSession from "../rpc/session.ts";
import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("desktop-local media fallback", () => {
  const remote = EnvironmentId.make("media-remote");
  const local = EnvironmentId.make("media-local");
  const threadId = ThreadId.make("remote-thread");

  const makeFallback = Effect.fn("TestAssetUrl.makeFallback")(function* () {
    const calls: Array<EnvironmentId> = [];
    const supervisor = (environmentId: EnvironmentId) =>
      Effect.gen(function* () {
        const session = {
          client: {
            [WS_METHODS.assetsCreateUrl]: ({ resource }: { resource: AssetResource }) =>
              Effect.suspend(() => {
                calls.push(environmentId);
                return environmentId === remote
                  ? Effect.fail(new AssetWorkspaceAssetNotFoundError({ resource }))
                  : Effect.succeed({ relativeUrl: "/api/assets/t/local.png", expiresAt: 4e12 });
              }),
          },
        } as unknown as RpcSession.RpcSession;
        return EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: environmentId,
            httpBaseUrl: `https://${environmentId}.test`,
            wsBaseUrl: `wss://${environmentId}.test`,
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            desired: true,
            network: "online",
            phase: "connected",
            attempt: 1,
            generation: 1,
          }),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      });
    const supervisors = new Map([
      [remote, yield* supervisor(remote)],
      [local, yield* supervisor(local)],
    ]);
    type Registry = EnvironmentRegistry.EnvironmentRegistry["Service"];
    const supervisorFor = (environmentId: EnvironmentId) => {
      const supervisor = supervisors.get(environmentId);
      if (!supervisor) throw new Error(`Missing test supervisor: ${environmentId}`);
      return supervisor;
    };
    const run: Registry["run"] = (environmentId, effect) =>
      Effect.provideService(
        effect,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisorFor(environmentId),
      );
    const followStream: Registry["followStream"] = (environmentId, stream) =>
      Stream.provideService(
        stream,
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisorFor(environmentId),
      );
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run,
      followStream,
    } as unknown as Registry);
    const registry = AtomRegistry.make();
    yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
    const atoms = createAssetEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
      Atom.make({ environmentId: local, httpBaseUrl: "https://media-local.test" }),
    );
    const load = (source: string) => {
      const media = resolveMediaSource(source, { threadId, workspaceRoot: "/tmp/repo" });
      if (media?.access !== "environment") throw new Error(`${source} is not host media`);
      calls.length = 0;
      return AtomRegistry.getResult(
        registry,
        atoms.createUrl({ environmentId: remote, input: { resource: media.resource } }),
      ).pipe(
        Effect.result,
        Effect.map((result) => ({ loaded: result._tag === "Success", calls: [...calls] })),
      );
    };
    return { load };
  });

  it.effect("keeps a relative Markdown image on the thread environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { load } = yield* makeFallback();
        expect(yield* load("docs/report.png")).toEqual({ loaded: false, calls: [remote] });
      }),
    ),
  );

  it.effect("retains desktop fallback for an absolute Markdown image", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { load } = yield* makeFallback();
        expect(yield* load("/tmp/repo/docs/report.png")).toEqual({
          loaded: true,
          calls: [remote, local],
        });
      }),
    ),
  );
});
