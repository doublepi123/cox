// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderMaintenance from "@t3tools/provider-core/server/maintenanceResolver";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import { OPENCODE_2_RESPONSES, replayOpenCodeServer } from "./probeResponses.fixture.ts";
import { OpenCodeDriver, openCodeUpdateFor } from "./driver.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const serverStarts: Array<string> = [];
const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({
    settings: { ...DEFAULT_SERVER_SETTINGS, providerHealthRefreshInterval: Duration.minutes(5) },
  }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (
  config: Partial<OpenCodeSettings>,
  http: HttpClient.HttpClient,
  environment: Parameters<typeof OpenCodeDriver.create>[0]["environment"] = [],
) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment,
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
  it.effect(
    "isolates model service sessions while preserving shared servers for other instances",
    () =>
      Effect.gen(function* () {
        const shared = yield* create({}, noHttp);
        const bound = yield* create({}, noHttp, [
          { name: "COX_MODEL_SERVICE_KEY", value: "local-key", sensitive: true },
        ]);
        yield* shared.snapshot.refresh;
        yield* bound.snapshot.refresh;
        assert.isTrue(
          (yield* shared.orchestrationAdapter.getCapabilities()).sessions
            .supportsMultipleProviderThreadsPerSession,
        );
        assert.isFalse(
          (yield* bound.orchestrationAdapter.getCapabilities()).sessions
            .supportsMultipleProviderThreadsPerSession,
        );
      }).pipe(Effect.scoped),
  );
  it.effect("offers installation only for local instances without a custom executable", () =>
    Effect.gen(function* () {
      for (const [config, canInstall] of [
        [{ enabled: false }, true],
        [{ enabled: false, binaryPath: "/custom/opencode" }, false],
        [{ enabled: false, serverUrl: "http://127.0.0.1:4096" }, false],
      ] as const) {
        const instance = yield* create(config, noHttp);
        assert.isDefined(instance.installation);
        const snapshot = yield* instance.snapshot.getSnapshot;
        assert.deepEqual(snapshot.setup, {
          canInstall,
          canAuthenticate: false,
          documentationUrl: "https://opencode.ai/v2/docs/",
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("never starts a 1.x server for an OpenCode 2 instance", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const instance = yield* create({}, noHttp);
      yield* Effect.flip(
        instance.textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        }),
      );
      assert.deepStrictEqual(serverStarts, ["start"]);
    }).pipe(Effect.scoped),
  );

  it.effect("discovers directory-specific agents for model-service custom models", () =>
    Effect.gen(function* () {
      const http = HttpClient.make((request, url) => {
        const directory = url.searchParams.get("location[directory]") ?? "/work";
        const agentId = directory === "/project-a" ? "orchestrator" : "reviewer";
        const body =
          url.pathname === "/api/info"
            ? { version: "2.2.5", pid: 123, urls: [], paths: { tmp: "/tmp/opencode" } }
            : url.pathname === "/api/config"
              ? [{ type: "document", info: { default_agent: agentId } }]
              : {
                  location: { directory },
                  data:
                    url.pathname === "/api/agent"
                      ? [
                          {
                            id: agentId,
                            name: agentId,
                            mode: "primary",
                            hidden: false,
                            request: { settings: {}, headers: {}, body: {} },
                            permissions: [],
                          },
                        ]
                      : url.pathname === "/api/model"
                        ? [
                            {
                              id: "test",
                              modelID: "test",
                              providerID: "cox",
                              name: "Test",
                              package: "@opencode/ai/providers/openai-compatible",
                              settings: {},
                              compatibility: {},
                              capabilities: { tools: true, input: ["text"], output: ["text"] },
                              variants: [],
                              time: { released: 1789516800000 },
                              cost: [],
                              status: "active",
                              enabled: true,
                              limit: { context: 64000, output: 4000 },
                            },
                          ]
                        : url.pathname === "/api/command"
                          ? [{ name: "init" }]
                          : [],
                };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            url.pathname === "/api/event"
              ? new Response(": heartbeat\n\n", {
                  headers: { "content-type": "text/event-stream" },
                })
              : Response.json(body),
          ),
        );
      });
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", customModels: ["cox/test"] },
        http,
      );
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "ready");
      for (const [cwd, expected] of [
        ["/project-a", "orchestrator"],
        ["/project-b", "reviewer"],
      ] as const) {
        const snapshot = yield* instance.snapshotForCwd!(cwd);
        assert.strictEqual(snapshot.status, "ready");
        assert.isNotEmpty(snapshot.models);
        assert.deepEqual(snapshot.optionDescriptors?.[0], {
          id: "agent",
          label: "Agent",
          type: "select",
          options: [{ id: expected, label: expected, isDefault: true }],
          currentValue: expected,
        });
        for (const model of snapshot.models) {
          const descriptor = model.capabilities?.optionDescriptors?.find(
            (option) => option.id === "agent",
          );
          assert.deepEqual(descriptor, {
            id: "agent",
            label: "Agent",
            type: "select",
            options: [{ id: expected, label: expected, isDefault: true }],
            currentValue: expected,
          });
          assert.strictEqual(model.slug, "cox/test");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    "1.18.32",
    "opencode v2.0.18",
    "opencode v2.2.4",
    "opencode v2.2.5",
    "opencode v2.2.6",
  ])("advertises native goal support only for supported OpenCode versions: %s", (version) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-goal-capability-" });
      const binaryPath = NodePath.join(
        root,
        "lib",
        "node_modules",
        "@opencode",
        "cli",
        "bin",
        "opencode",
      );
      yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "");
      const instance = yield* create({ binaryPath }, noHttp).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          ...openCode2Runtime,
          runOpenCodeCommand: () => Effect.succeed({ stdout: version, stderr: "", code: 0 }),
        }),
      );
      yield* instance.snapshot.resolveMaintenance({ fresh: true });
      const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
      assert.equal(
        capabilities.turns.supportsNativeGoals === true,
        version.endsWith("2.2.5") || version.endsWith("2.2.6"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("uses the connected OpenCode version for goal support after an upgrade", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-upgraded-goals-" });
      const binaryPath = NodePath.join(
        root,
        "lib",
        "node_modules",
        "@opencode",
        "cli",
        "bin",
        "opencode",
      );
      yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "");
      const http = HttpClient.make((request) => {
        const path = new URL(request.url).pathname;
        if (path === "/api/info")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                ...JSON.parse(OPENCODE_2_RESPONSES["/api/info"].body),
                version: "2.2.5",
              }),
            ),
          );
        if (path === "/api/model")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ location: { directory: "/work" }, data: [] }),
            ),
          );
        if (path === "/api/event")
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(new ReadableStream(), {
                headers: { "content-type": "text/event-stream" },
              }),
            ),
          );
        return Effect.die(`Unexpected request: ${path}`);
      });
      const instance = yield* create({ binaryPath }, http).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          ...openCode2Runtime,
          runOpenCodeCommand: () =>
            Effect.succeed({ stdout: "opencode v2.2.4", stderr: "", code: 0 }),
          startOpenCodeServerProcess: ({ verify }) =>
            Effect.gen(function* () {
              const url = "http://127.0.0.1:4096";
              const version = verify ? yield* verify(url) : "2.2.5";
              return { url, version, isRunning: Effect.succeed(true), exitCode: Effect.never };
            }),
        }),
      );
      yield* instance.snapshot.resolveMaintenance({ fresh: true });
      assert.isFalse(
        (yield* instance.orchestrationAdapter.getCapabilities()).turns.supportsNativeGoals,
      );
      const session = yield* instance.orchestrationAdapter.openSession({
        threadId: ThreadId.make("upgraded-goal"),
        providerSessionId: ProviderSessionId.make("upgraded-goal"),
        modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
      });
      assert.isTrue(session.providerSession.capabilities.turns.supportsNativeGoals);
      assert.isTrue(
        (yield* instance.orchestrationAdapter.getCapabilities()).turns.supportsNativeGoals,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("answers capability reads without waiting on an unreachable server", () =>
    Effect.gen(function* () {
      const hang = HttpClient.make(() => Effect.never);
      const instance = yield* create({ serverUrl: "http://127.0.0.1:9" }, hang);

      const capabilities = yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(capabilities.pollUnsafe());
      yield* Fiber.join(capabilities);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect.each(["probe", "error", "empty"] as const)(
    "recovers discovery without a manual refresh after %s",
    (initialCatalog) =>
      Effect.gen(function* () {
        const releaseCatalog = yield* Deferred.make<void>();
        const discoveryLogs: Array<Record<string, unknown>> = [];
        const logger = Logger.make(({ message, fiber }) => {
          if (Array.isArray(message) && message.includes("OpenCode discovery failed")) {
            discoveryLogs.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
          }
        });
        let catalogAvailable = false;
        let modelReads = 0;
        const replies = {
          ...OPENCODE_2_RESPONSES,
          "/api/provider": {
            status: 200,
            contentType: "application/json",
            body: '{"location":{"directory":"/work"},"data":[]}',
          },
          "/api/model": {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              location: { directory: "/work" },
              data: [
                {
                  id: "big-pickle",
                  modelID: "big-pickle",
                  providerID: "opencode",
                  name: "Big Pickle",
                  package: "@opencode/ai/providers/openai-compatible",
                  settings: {},
                  compatibility: {},
                  capabilities: { tools: true, input: ["text"], output: ["text"] },
                  variants: [],
                  time: { released: 1789516800000 },
                  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
                  status: "active",
                  enabled: true,
                  limit: { context: 1000000, output: 65536 },
                },
              ],
            }),
          },
        };
        const replay = replayOpenCodeServer(replies, "secret");
        const server = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (initialCatalog === "probe" && !catalogAvailable) {
              yield* Deferred.await(releaseCatalog);
              return HttpClientResponse.fromWeb(
                request,
                new Response('{"_tag":"InternalServerError","message":"server starting"}', {
                  status: 503,
                  headers: { "content-type": "application/json" },
                }),
              );
            }
            if (new URL(request.url).pathname === "/api/model") {
              modelReads += 1;
              yield* Deferred.await(releaseCatalog);
              if (!catalogAvailable) {
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    initialCatalog === "error"
                      ? '{"_tag":"InternalServerError","message":"catalog unavailable"}'
                      : '{"location":{"directory":"/work"},"data":[]}',
                    {
                      status: initialCatalog === "error" ? 500 : 200,
                      headers: { "content-type": "application/json" },
                    },
                  ),
                );
              }
            }
            return yield* replay.execute(request);
          }),
        );
        const instance = yield* create(
          { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
          server,
        ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
        const initial = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.installed &&
              snapshot.status === (initialCatalog === "empty" ? "warning" : "error"),
          ),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseCatalog, undefined);
        yield* TestClock.adjust("5 seconds");
        const [failed] = Array.from(yield* Fiber.join(initial));
        assert.strictEqual(failed?.auth.status, "unknown");
        assert.deepStrictEqual(failed?.models, []);
        if (initialCatalog === "probe") assert.strictEqual(failed?.version, null);
        assert.strictEqual(discoveryLogs.length, 1);
        assert.strictEqual(discoveryLogs[0]?.providerInstanceId, "opencode-test");
        assert.strictEqual(discoveryLogs[0]?.serverMode, "external");
        assert.strictEqual(
          discoveryLogs[0]?.phase,
          initialCatalog === "probe" ? "version" : "models",
        );

        catalogAvailable = true;
        const recovered = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => snapshot.status === "ready"),
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "ready");
        const [ready] = Array.from(yield* Fiber.join(recovered));
        assert.strictEqual(ready?.auth.status, "authenticated");
        assert.deepStrictEqual(
          ready?.models.map((model) => model.slug),
          ["opencode/big-pickle"],
        );

        const readsAfterRecovery = modelReads;
        yield* TestClock.adjust("15 minutes");
        assert.strictEqual(modelReads, readsAfterRecovery);
        assert.strictEqual(discoveryLogs.length, 1);
      }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("does not retry a rejected server password in the background", () =>
    Effect.gen(function* () {
      const releaseResponse = yield* Deferred.make<void>();
      const requested: Array<string> = [];
      const server = replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret", requested);
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "wrong" },
        HttpClient.make((request) =>
          Deferred.await(releaseResponse).pipe(Effect.andThen(server.execute(request))),
        ),
      );
      // Wait for startup and its maintenance enrichment, both of which probe.
      const rejected = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) => snapshot.status === "error" && snapshot.versionAdvisory !== undefined,
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(releaseResponse, undefined);
      const [snapshot] = Array.from(yield* Fiber.join(rejected));
      assert.strictEqual(snapshot?.version, null);
      assert.strictEqual(snapshot?.auth.status, "unauthenticated");
      const readsAfterRejection = requested.length;

      yield* TestClock.adjust("15 minutes");
      assert.strictEqual(requested.length, readsAfterRejection);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

// npm links into opencode-ai for 1.x and @opencode/cli for 2.x.
const npmGlobalInstall = (prefix: string, packagePath: ReadonlyArray<string>, bin: string) => {
  const target = NodePath.join(prefix, "lib", "node_modules", ...packagePath, "bin", bin);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, "#!/bin/sh\n");
  NodeFS.chmodSync(target, 0o755);
  const link = NodePath.join(prefix, "bin", "opencode");
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
};
const resolveUpdate = (generation: "v1" | "v2", binaryPath: string) =>
  ProviderMaintenance.resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation), {
    binaryPath,
    env: { PATH: "" },
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("resolving an update must not spawn")),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "updates an npm-global OpenCode 2 install as @opencode/cli and a 1.x one as opencode-ai",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-update-")),
      );
      const v2Prefix = NodePath.join(root, "v2");
      const v1Prefix = NodePath.join(root, "v1");
      const v2 = yield* resolveUpdate(
        "v2",
        npmGlobalInstall(v2Prefix, ["@opencode", "cli"], "opencode.exe"),
      );
      assert.deepStrictEqual(v2.update?.args, [
        "install",
        "-g",
        "--prefix",
        v2Prefix,
        "--allow-scripts=@opencode/cli",
        "@opencode/cli@latest",
      ]);
      const v1 = yield* resolveUpdate(
        "v1",
        npmGlobalInstall(v1Prefix, ["opencode-ai"], "opencode"),
      );
      assert.strictEqual(v1.update?.args.at(-1), "opencode-ai@latest");
      assert.isNull(
        (yield* resolveUpdate("v2", NodePath.join(v1Prefix, "bin", "opencode"))).update,
      );
      assert.isNull(
        (yield* resolveUpdate("v1", NodePath.join(v2Prefix, "bin", "opencode"))).update,
      );
    }),
);

const versionOutput: { current: string | undefined } = { current: undefined };
const versionProbes: Array<string> = [];
const changingRuntime = {
  runOpenCodeCommand: ({ binaryPath }: { readonly binaryPath: string }) =>
    Effect.sync(() => versionProbes.push(binaryPath)).pipe(
      Effect.andThen(
        versionOutput.current === undefined
          ? Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "version",
                detail: "no version",
              }),
            )
          : Effect.succeed({ stdout: versionOutput.current, stderr: "", code: 0 }),
      ),
    ),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layerUpdate = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, changingRuntime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layerUpdate)("OpenCodeDriver updates", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "offers no package update for an unknown version and follows a changed one on a fresh read",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.realpathSync(
          NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-opencode-driver-update-")),
        );
        const binaryPath = npmGlobalInstall(NodePath.join(root, "v1"), ["opencode-ai"], "opencode");
        const instance = yield* OpenCodeDriver.create({
          instanceId: ProviderInstanceId.make("opencode-update"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: { ...OpenCodeDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));

        versionOutput.current = undefined;
        const unknown = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(unknown.update);
        assert.isNull(unknown.packageName);

        versionOutput.current = "1.18.32\n";
        const v1 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v1.packageName, "opencode-ai");

        versionOutput.current = "opencode v2.0.18\n";
        const v2 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v2.packageName, "@opencode/cli");
        assert.isNull(v2.update);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "opens sessions through OpenCode 2 after the binary is upgraded in place from 1.x",
    () =>
      Effect.gen(function* () {
        versionOutput.current = "1.18.18\n";
        const instance = yield* create({}, noHttp);
        // Let the startup status check claim the refresh permit, then wait behind it so it
        // cannot probe after the upgrade below.
        yield* Effect.yieldNow;
        yield* instance.snapshot.refresh;
        serverStarts.length = 0;
        const openSession = instance.orchestrationAdapter
          .openSession({
            threadId: ThreadId.make("thread-upgraded"),
            providerSessionId: ProviderSessionId.make("session-upgraded"),
            modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          })
          .pipe(Effect.scoped, Effect.flip);

        yield* openSession;
        assert.deepStrictEqual(serverStarts, ["connect"], "1.x opens through the 1.x adapter");

        versionOutput.current = "opencode v2.2.4\n";
        serverStarts.length = 0;
        yield* openSession;
        assert.notInclude(
          serverStarts,
          "connect",
          "after upgrading to 2.x, the next session must not open through the 1.x adapter",
        );
        assert.include(serverStarts, "start", "the OpenCode 2 adapter starts its server");
      }).pipe(Effect.scoped),
  );
});
