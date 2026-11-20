import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
} from "./driver.ts";
import { normalizeAcpRegistryLiveConfiguration } from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      AcpRegistryRuntimeCoordinator.layer,
      IdAllocator.layer,
      McpProviderSessions.layer,
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
  ),
);

it.layer(driverLayer, { excludeTestServices: true })("AcpRegistryDriver", (it) => {
  it.effect("keeps each model's session choices alongside shared mode through refresh", () =>
    Effect.gen(function* () {
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const modelState = {
        currentModelId: "model-a",
        availableModels: [
          { modelId: "model-a", name: "Model A" },
          { modelId: "model-b", name: "Model B" },
        ],
      };
      const mode = {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: "ask",
        options: [{ value: "ask", name: "Ask" }],
      } as const satisfies EffectAcpSchema.SessionConfigOption;
      const effort = {
        id: "effort",
        name: "Effort",
        category: "thought_level",
        type: "select",
        currentValue: "low",
        options: [
          { value: "low", name: "Low" },
          { value: "high", name: "High" },
        ],
      } as const satisfies EffectAcpSchema.SessionConfigOption;
      const agent = String.raw`
        import { createInterface } from "node:readline";
        const { models, configOptions } = JSON.parse(process.argv[1]);
        const sessionId = "model-options-probe";
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
        for await (const line of createInterface({ input: process.stdin })) {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, authMethods: [] } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId, models, configOptions } });
            send({ method: "session/update", params: {
              sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] },
            } });
          } else if (id !== undefined) {
            send({ id, error: { code: -32601, message: "Method not found" } });
          }
        }
      `;
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: {
                command: process.execPath,
                args: [
                  "--input-type=module",
                  "-e",
                  agent,
                  JSON.stringify({ models: modelState, configOptions: [mode, effort] }),
                ],
              },
            }),
        }),
      );
      const selectChoicesByModel = (snapshot: ServerProvider) =>
        Object.fromEntries(
          snapshot.models.map((model) => [
            model.slug,
            Object.fromEntries(
              (model.capabilities?.optionDescriptors ?? []).flatMap((option) =>
                option.type === "select"
                  ? [[option.id, option.options.map((choice) => choice.id)]]
                  : [],
              ),
            ),
          ]),
        );
      const watchDefaultModel = (slug: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            snapshot.models.some((model) => model.slug === slug && model.isDefault),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.timeout("5 seconds"),
          Effect.forkScoped({ startImmediately: true }),
        );

      const initial = yield* watchDefaultModel("model-a");
      yield* instance.snapshot.refresh;
      const before = yield* Fiber.join(initial);
      const live = yield* watchDefaultModel("model-b");
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        normalizeAcpRegistryLiveConfiguration(
          [
            mode,
            {
              ...effort,
              currentValue: "balanced",
              options: [{ value: "balanced", name: "Balanced" }],
            },
          ],
          undefined,
          { ...modelState, currentModelId: "model-b" },
        ),
      );
      const after = yield* Fiber.join(live);
      const refreshed = yield* instance.snapshot.refresh;

      expect({
        before: selectChoicesByModel(before),
        after: selectChoicesByModel(after),
        refreshed: selectChoicesByModel(refreshed),
      }).toEqual({
        before: {
          "model-a": { mode: ["ask"], effort: ["low", "high"] },
          "model-b": { mode: ["ask"] },
        },
        after: {
          "model-a": { mode: ["ask"], effort: ["low", "high"] },
          "model-b": { mode: ["ask"], effort: ["balanced"] },
        },
        refreshed: {
          "model-a": { mode: ["ask"], effort: ["low", "high"] },
          "model-b": { mode: ["ask"], effort: ["balanced"] },
        },
      });
    }),
  );
});

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

describe("acpRegistrySnapshotReadiness", () => {
  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [] },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });
    const modelsAfterLoad = (
      configOptions: Parameters<typeof applyAcpRegistryLiveConfiguration>[1]["configOptions"],
    ) =>
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions },
        [],
      ).models;
    expect(modelsAfterLoad([])).toEqual(provider.models);
    expect(
      modelsAfterLoad([
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [{ id: "high", label: "High" }],
          currentValue: "high",
        },
      ]),
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toBe(environment);
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );
});
