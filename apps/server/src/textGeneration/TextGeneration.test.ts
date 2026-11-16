import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelServiceConfig,
  ModelServiceId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  TextGenerationError,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "./TextGeneration.ts";

const serviceId = ModelServiceId.make("title-defaults");
const primaryId = ProviderInstanceId.make("codex-bound");
const fallbackId = ProviderInstanceId.make("claude-bound");
const ompId = ProviderInstanceId.make("omp-fixture");
const projectId = ProjectId.make("gate-project");
const service = Schema.decodeSync(ModelServiceConfig)({
  name: "Title models",
  baseUrl: "https://models.test/v1",
  protocols: ["openai-chat"],
  models: [{ id: "gpt-6.1-sol" }, { id: "gpt-5.6-luna" }],
});
const settings: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  modelServices: { [serviceId]: service },
  providerInstances: {
    [primaryId]: {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {},
      modelService: { serviceId, modelIds: ["gpt-6.1-sol"], defaultModel: "gpt-6.1-sol" },
    },
    [fallbackId]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      config: {},
      modelService: { serviceId, modelIds: ["gpt-5.6-luna"], defaultModel: "gpt-5.6-luna" },
    },
  },
};
const primaryInstance = settings.providerInstances[primaryId];
const fallbackInstance = settings.providerInstances[fallbackId];
if (primaryInstance === undefined || fallbackInstance === undefined)
  throw new Error("Text generation fixture requires both configured providers");

function harness(
  configured: ServerSettings,
  exhausted = false,
  snapshotOverrides?: Readonly<Partial<Record<ProviderInstanceId, Partial<ServerProvider>>>>,
) {
  return Effect.gen(function* () {
    const calls: ModelSelection[] = [];
    const invocations: ProviderInstanceId[] = [];
    const instances: ProviderInstance[] = Object.entries(configured.providerInstances).map(
      ([id, config]) => {
        const instanceId = ProviderInstanceId.make(id);
        const driver = config.driver;
        const snapshot: ServerProvider = {
          instanceId,
          driver,
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated" },
          version: null,
          checkedAt: "2026-11-04T00:00:00.000Z",
          modelCatalogSource: "model-service",
          models: [
            {
              slug: config.modelService?.defaultModel ?? "fixture/fixture",
              name: "Configured",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
          ...(exhausted && instanceId === primaryId
            ? {
                usageLimits: {
                  checkedAt: "2026-11-04T00:00:00.000Z",
                  windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
                },
              }
            : {}),
          ...snapshotOverrides?.[instanceId],
        };
        const record = (selection: ModelSelection) =>
          Effect.sync(() => {
            invocations.push(instanceId);
            calls.push(selection);
          });
        return {
          instanceId,
          driverKind: driver,
          continuationIdentity: { driverKind: driver, continuationKey: instanceId },
          displayName: undefined,
          enabled: true,
          snapshot: {
            getSnapshot: Effect.succeed(snapshot),
            refresh: Effect.succeed(snapshot),
            resolveMaintenance: () => Effect.die("unused"),
            streamChanges: Stream.empty,
            applyUsageLimits: () => Effect.die("unused"),
          },
          orchestrationAdapter: {
            instanceId,
            driver,
            getCapabilities: () => Effect.die("unused"),
            planSelectionTransition: () => Effect.die("unused"),
            openSession: () => Effect.die("unused"),
          },
          textGeneration: TextGeneration.TextGeneration.of({
            generateThreadTitle: (input) =>
              record(input.modelSelection).pipe(Effect.as({ title: "Generated title" })),
            generateBranchName: (input) =>
              record(input.modelSelection).pipe(Effect.as({ branch: "fix/defaults" })),
            generateCommitMessage: () => Effect.die("unused"),
            generatePrContent: () => Effect.die("unused"),
            generateReviewGuide: () => Effect.die("unused"),
          }),
        };
      },
    );
    const generate = yield* TextGeneration.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            listInstances: Effect.succeed(instances),
            getInstance: (id) =>
              Effect.succeed(instances.find((instance) => instance.instanceId === id)),
          }),
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.succeed(configured),
          }),
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
        ),
      ),
    );
    return { generate, calls, invocations };
  });
}

it.effect.each([false, true])(
  "uses only bound models for text generation (primary exhausted: %s)",
  (exhausted) =>
    Effect.gen(function* () {
      const { generate, calls } = yield* harness(settings, exhausted);
      const stale = createModelSelection(primaryId, "gpt-6-luna", [
        { id: "reasoningEffort", value: "low" },
      ]);
      expect(
        yield* generate.generateThreadTitle({
          modelSelection: stale,
          cwd: "/repo",
          message: "hello",
          linkedContext: "",
        }),
      ).toEqual({ title: "Generated title" });
      expect(calls).toEqual([
        createModelSelection(
          exhausted ? fallbackId : primaryId,
          exhausted ? "gpt-5.6-luna" : "gpt-6.1-sol",
        ),
      ]);
      expect(stale.model).toBe("gpt-6-luna");
    }),
);

it.effect("keeps an explicitly selected bound model and its options", () =>
  Effect.gen(function* () {
    const { generate, calls } = yield* harness(settings);
    const selected = createModelSelection(primaryId, "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "high" },
    ]);
    yield* generate.generateThreadTitle({
      modelSelection: selected,
      cwd: "/repo",
      message: "hello",
      linkedContext: "",
    });
    expect(calls).toEqual([selected]);
  }),
);

it.effect("does not invoke a model when every bound model is unavailable", () =>
  Effect.gen(function* () {
    const { generate, calls } = yield* harness({
      ...settings,
      modelServices: {
        [serviceId]: {
          ...service,
          models: service.models.map((model) => ({ ...model, available: false })),
        },
      },
    });
    const error = yield* Effect.flip(
      generate.generateThreadTitle({
        modelSelection: createModelSelection(primaryId, "gpt-6-luna"),
        cwd: "/repo",
        message: "hello",
        linkedContext: "",
      }),
    );
    expect(error.operation).toBe("generateThreadTitle");
    expect(error.detail).toContain("No available text generation model");
    expect(calls).toEqual([]);
  }),
);

it.effect("does not change a main branch-generation model that is already allowed", () =>
  Effect.gen(function* () {
    const { generate, calls } = yield* harness(settings);
    const selected = createModelSelection(primaryId, "gpt-6.1-sol", [
      { id: "reasoningEffort", value: "ultra" },
    ]);
    expect(
      yield* generate.generateBranchName({
        modelSelection: selected,
        cwd: "/repo",
        message: "hello",
      }),
    ).toEqual({ branch: "fix/defaults" });
    expect(calls).toEqual([selected]);
  }),
);

const disabledPrimarySettings: ServerSettings = {
  ...settings,
  providerInstances: {
    [primaryId]: { ...primaryInstance, enabled: false },
    [ompId]: {
      driver: ProviderDriverKind.make("omp"),
      enabled: true,
      config: {},
    },
  },
};

it.effect(
  "falls back to an enabled provider instead of invoking a disabled selected provider",
  () =>
    Effect.gen(function* () {
      const { generate, calls, invocations } = yield* harness(disabledPrimarySettings, false, {
        [primaryId]: { enabled: false },
      });
      expect(
        yield* generate.generateThreadTitle({
          modelSelection: createModelSelection(primaryId, "gpt-6-luna"),
          cwd: "/repo",
          message: "hello",
          linkedContext: "",
        }),
      ).toEqual({ title: "Generated title" });
      expect(calls).toEqual([createModelSelection(ompId, "fixture/fixture")]);
      expect(invocations).toEqual([ompId]);
    }),
);

it.effect(
  "returns an explicit error instead of invoking a disabled provider without fallback",
  () =>
    Effect.gen(function* () {
      const { generate, calls, invocations } = yield* harness(
        {
          ...settings,
          providerInstances: {
            [primaryId]: { ...primaryInstance, enabled: false },
            [fallbackId]: { ...fallbackInstance, enabled: false },
          },
        },
        false,
        { [primaryId]: { enabled: false }, [fallbackId]: { enabled: false } },
      );
      const error = yield* Effect.flip(
        generate.generateThreadTitle({
          modelSelection: createModelSelection(primaryId, "gpt-6-luna"),
          cwd: "/repo",
          message: "hello",
          linkedContext: "",
        }),
      );
      expect(error).toBeInstanceOf(TextGenerationError);
      expect(error.operation).toBe("generateThreadTitle");
      expect(error.detail).toContain("disabled");
      expect(calls).toEqual([]);
      expect(invocations).toEqual([]);
    }),
);

it.effect("does not invoke a provider disabled for the project", () =>
  Effect.gen(function* () {
    const { generate, calls, invocations } = yield* harness({
      ...settings,
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [primaryId]: { enabled: false } } },
      },
    });
    yield* generate.generateThreadTitle({
      modelSelection: createModelSelection(primaryId, "gpt-6-luna"),
      projectId,
      cwd: "/repo",
      message: "hello",
      linkedContext: "",
    });
    expect(calls).toEqual([createModelSelection(fallbackId, "gpt-5.6-luna")]);
    expect(invocations).toEqual([fallbackId]);
  }),
);
