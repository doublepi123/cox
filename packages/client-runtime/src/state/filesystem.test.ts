import { describe, expect, it, vi } from "@effect/vitest";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type FilesystemBrowseResult,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import { RpcClient } from "effect/rpc";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { entry, target } from "../connection/localTestFixtures.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  createBrowseNavigationCoordinator,
  createFilesystemEnvironmentAtoms,
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
  getFilesystemBrowseTabCompletion,
  resolveFilesystemReadAccess,
} from "./filesystem.ts";

const SPLIT_SCOPES_SERVER = { serverUpdateScope: "environment:maintain" } as const;

describe("filesystem read access", () => {
  it("waits for the initial catalog before declaring a missing environment disconnected", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: false,
        connection: null,
        session: null,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: true, error: null });
  });

  it.each([false, true])(
    "preserves a cached file grant offline with catalog ready=%s",
    (isCatalogReady) => {
      const input = {
        isCatalogReady,
        connection: { phase: "offline", error: null },
        session: { authenticated: true, scopes: [AuthFilesystemReadScope] },
        sessionError: null,
      } as const;
      expect(resolveFilesystemReadAccess(input)).toEqual({
        canReadFiles: true,
        isPending: false,
        error: null,
      });
      expect(
        resolveFilesystemReadAccess({ ...input, sessionError: "The session has expired." }),
      ).toEqual({ canReadFiles: false, isPending: false, error: "The session has expired." });
    },
  );

  it.each([
    { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: SPLIT_SCOPES_SERVER },
    { authenticated: false, scopes: [AuthFilesystemReadScope], auth: SPLIT_SCOPES_SERVER },
  ] as const)("does not infer file access from an ungranted session", (session) => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session,
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: false, isPending: false, error: null });
  });

  it("falls back to the orchestration grant on a server that predates filesystem:read", () => {
    expect(
      resolveFilesystemReadAccess({
        isCatalogReady: true,
        connection: { phase: "connected", error: null },
        session: { authenticated: true, scopes: [AuthOrchestrationReadScope], auth: {} },
        sessionError: null,
      }),
    ).toEqual({ canReadFiles: true, isPending: false, error: null });
  });

  it("completes Tab like a shell", () => {
    const entry = (name: string) => ({ name, fullPath: `/Users/me/${name}` });
    expect(getFilesystemBrowseTabCompletion([entry("Creations")], "Creation")).toEqual({
      name: "Creations",
      isComplete: true,
    });
    expect(getFilesystemBrowseTabCompletion([entry("OpenSourced"), entry("OpenAI")], "op")).toEqual(
      { name: "Open", isComplete: false },
    );
    expect(getFilesystemBrowseTabCompletion([entry("Open"), entry("Opal")], "Op")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("openAI"), entry("OpenSource")], "o")).toEqual({
      name: "open",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([entry("😀one"), entry("😁two")], "")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("ΟΣα"), entry("οσβ")], "ο")).toBeNull();
    expect(getFilesystemBrowseTabCompletion([entry("İfoo"), entry("İfar")], "i\u0307")).toEqual({
      name: "İf",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([entry("😀one"), entry("😀other")], "😀")).toEqual({
      name: "😀o",
      isComplete: false,
    });
    expect(getFilesystemBrowseTabCompletion([], "x")).toBeNull();
  });
});

describe("filesystem browse model", () => {
  it("ranks prefix, substring, and fuzzy folder matches and filters hidden entries", () => {
    const entries = ["c-o-x", "mycox", ".cox", "cox-tools", "cox", "other"].map((name) => ({
      name,
      fullPath: `/root/${name}`,
    }));
    const { visibleEntries, exactEntry } = filterFilesystemBrowseEntries(entries, "cox");
    expect(visibleEntries.map(({ name }) => name)).toEqual(["cox", "cox-tools", "mycox", "c-o-x"]);
    expect(exactEntry?.name).toBe("cox");
    expect(
      filterFilesystemBrowseEntries(entries, ".cox").visibleEntries.map(({ name }) => name),
    ).toEqual([".cox"]);
  });

  it("derives the browse target and navigation state", () => {
    expect(getFilesystemBrowsePath("~/projects/t3")).toEqual({
      isBrowsing: true,
      directoryPath: "~/projects/",
      filterQuery: "t3",
      parentPath: "~/",
      canBrowseUp: true,
    });
    expect(getFilesystemBrowsePath("C:\\Users\\test", "MacIntel").isBrowsing).toBe(false);
    expect(getFilesystemBrowsePath("~/projects/", "", false).isBrowsing).toBe(false);
  });

  it.effect("reads the updated folder listing when reopened after the idle cache expires", () =>
    Effect.gen(function* () {
      const oldFolder = { name: "old", fullPath: "/projects/old" };
      const listing: { entries: FilesystemBrowseResult["entries"] } = { entries: [oldFolder] };
      const rpc = yield* RpcClient.makeNoSerialization(WsRpcGroup, {
        onFromClient: ({ message }): Effect.Effect<void> => {
          if (message._tag !== "Request") return Effect.void;
          if (message.tag !== WS_METHODS.filesystemBrowse) {
            return Effect.die(new Error(`Unexpected fixture RPC: ${message.tag}`));
          }
          return Effect.promise(() => Promise.resolve()).pipe(
            Effect.andThen(() =>
              rpc.write({
                _tag: "Exit",
                clientId: 0,
                requestId: message.id,
                exit: Exit.succeed({ parentPath: "/projects", entries: listing.entries }),
              }),
            ),
          );
        },
      });
      const supervisor = EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected",
        }),
        session: yield* SubscriptionRef.make(
          Option.some<RpcSession>({
            client: rpc.client,
            initialConfig: Effect.never,
            subscribeServerConfig: () => Stream.empty,
            ready: Effect.void,
            probe: Effect.void,
            inboundFrames: Effect.succeed(0),
            closed: Effect.never,
          }),
        ),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const environments = EnvironmentRegistry.of({
        entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
          new Map([[target.environmentId, entry]]),
        ),
        networkStatus: yield* SubscriptionRef.make<NetworkStatus>("online"),
        reconcilePlatform: () => Effect.void,
        retryNow: () => Effect.void,
        state: () => SubscriptionRef.get(supervisor.state),
        stateChanges: () => SubscriptionRef.changes(supervisor.state),
        run: (_, effect) => Effect.provideService(effect, EnvironmentSupervisor, supervisor),
        runStream: (_, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        followStream: (_, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
      });
      const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, environments));
      const { browse } = createFilesystemEnvironmentAtoms(runtime);
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const query = browse({
        environmentId: target.environmentId,
        input: { partialPath: "/projects/" },
      });
      const readListing = AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
        Effect.tap(() => Effect.yieldNow),
      );
      const unmount = registry.mount(query);
      expect((yield* readListing).entries).toEqual([oldFolder]);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      unmount();

      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(6_001));
      const newFolder = { name: "new", fullPath: "/projects/new" };
      listing.entries = [newFolder];
      yield* AtomRegistry.mount(registry, query);
      expect((yield* readListing).entries).toEqual([newFolder]);
    }).pipe(Effect.scoped),
  );
});

describe("browse navigation", () => {
  it("only commits the latest valid navigation", async () => {
    const navigation = createBrowseNavigationCoordinator();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const commits: string[] = [];
    const commit = (name: string) => () => commits.push(name);
    const firstRun = navigation.run(() => first.promise, commit("first"));
    const secondRun = navigation.run(() => second.promise, commit("second"));

    second.resolve();
    await expect(secondRun).resolves.toBe(true);
    first.resolve();
    await expect(firstRun).resolves.toBe(false);

    const invalidated = Promise.withResolvers<void>();
    const invalidatedRun = navigation.run(() => invalidated.promise, commit("stale"));
    navigation.invalidate();
    invalidated.resolve();

    await expect(invalidatedRun).resolves.toBe(false);
    expect(commits).toEqual(["second"]);
  });
});
