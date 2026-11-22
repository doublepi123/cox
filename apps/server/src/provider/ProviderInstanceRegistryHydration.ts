import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ProviderInstanceId,
  providerInstanceConfigEnabledFlag,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  ServerSettings,
  ModelServiceError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";

import * as Settings from "../serverSettings.ts";
import * as SecretResolver from "../secrets/SecretResolver.ts";
import { BUILT_IN_DRIVERS, type BuiltInDriversEnv } from "./builtInDrivers.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import { makeSettingsSynchronizer } from "./providerSettingsSynchronizer.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as ProviderHostLive from "./ProviderHostLive.ts";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import type * as PortScanner from "../preview/PortScanner.ts";
import { ModelServiceGateway } from "../modelServices/ModelServiceGateway.ts";

type ProviderInstanceRegistryHydrationEnv =
  | Exclude<
      BuiltInDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | Settings.ServerSettingsService
  | BackgroundPolicy.BackgroundPolicy
  | ServerConfig.ServerConfig
  | Path.Path
  | FileSystem.FileSystem
  // Secret provider reads.
  | SecureRandom.SecureRandom
  // The Claude runner counts its CLIs as running agents for port discovery.
  | PortScanner.PortDiscovery;

export const deriveProviderInstanceConfigMap = (
  settings: ServerSettings,
): ProviderInstanceConfigMap => {
  const merged: Record<string, ProviderInstanceConfig> = { ...settings.providerInstances };
  const deletedDefaults = new Set(settings.deletedDefaultProviderInstances);
  for (const instanceId of deletedDefaults) {
    delete merged[instanceId];
  }

  const defaultDrivers = new Map(
    BUILT_IN_DRIVERS.filter((driver) => driver.metadata.hasDefaultInstance !== false).map(
      (driver) => [defaultInstanceIdForDriver(driver.driverKind), driver.driverKind] as const,
    ),
  );

  // Probe project-enabled instances even if disabled machine-wide; project threads can still route to them.
  for (const overrides of Object.values(settings.projectSettingsOverrides)) {
    for (const [rawInstanceId, projectOverride] of Object.entries(
      overrides?.providerInstances ?? {},
    )) {
      if (projectOverride.enabled !== true) continue;
      const instanceId = rawInstanceId as ProviderInstanceId;
      const existing = merged[instanceId];
      if (existing === undefined) {
        const driver = defaultDrivers.get(instanceId);
        if (driver !== undefined && !deletedDefaults.has(instanceId)) {
          merged[instanceId] = { driver, enabled: true };
        }
        continue;
      }
      if (resolveProviderInstanceEnabled(existing)) continue;
      merged[instanceId] = {
        ...existing,
        enabled: true,
        ...(providerInstanceConfigEnabledFlag(existing.config) === false
          ? { config: { ...(existing.config as Record<string, unknown>), enabled: true } }
          : {}),
      };
    }
  }

  return merged as ProviderInstanceConfigMap;
};

export const DEV_REPLAY_INSTANCE_ID = ProviderInstanceId.make("devReplay");

/**
 * Dev servers run from source keep a free ACP agent that replays recorded turns, so UI checks
 * need no paid model. Bundled servers, such as desktop dev, have no agent script and skip it.
 */
export const seedDevReplayInstance = Effect.fn(
  "ProviderInstanceRegistryHydration.seedDevReplayInstance",
)(function* () {
  const config = yield* ServerConfig.ServerConfig;
  if (config.devUrl === undefined) return;
  const path = yield* Path.Path;
  const agentPath = yield* path.fromFileUrl(
    new URL("../../scripts/dev-replay-agent.ts", import.meta.url),
  );
  if (!(yield* (yield* FileSystem.FileSystem).exists(agentPath))) return;
  const commandPath = yield* HostProcess.ExecutablePath;
  const serverSettings = yield* Settings.ServerSettingsService;
  const existing = (yield* serverSettings.getSettings).providerInstances[DEV_REPLAY_INSTANCE_ID];
  const existingConfig = existing?.config as Record<string, unknown> | undefined;
  // Rewritten only when stale: the node and checkout paths can move.
  if (
    existingConfig?.commandPath === commandPath &&
    (existingConfig.commandArgs as ReadonlyArray<unknown> | undefined)?.[0] === agentPath
  ) {
    return;
  }
  // Keeps user edits, such as turning the provider off.
  const instance: ProviderInstanceConfig = {
    displayName: "Replay (dev)",
    ...existing,
    driver: ProviderDriverKind.make("acpRegistry"),
    config: { ...existingConfig, source: "local", commandPath, commandArgs: [agentPath] },
  };
  yield* serverSettings.updateProviderInstance({
    operation: "upsert",
    instanceId: DEV_REPLAY_INSTANCE_ID,
    instance,
  });
});

export const materializeInstances = Effect.fn("materializeModelServiceInstances")(function* (
  settings: ServerSettings,
) {
  const instances = deriveProviderInstanceConfigMap(settings);
  const gateway = yield* Effect.serviceOption(ModelServiceGateway);
  if (Option.isNone(gateway)) {
    if (!Object.values(instances).some((entry) => entry.modelService)) return instances;
    return yield* new ModelServiceError({ detail: "The model service gateway is unavailable." });
  }
  return yield* gateway.value.materialize(settings, instances);
});

export const layerSettingsWatcher = (
  settingsChanges: Stream.Stream<ServerSettings>,
  initialSettings: ServerSettings | undefined,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { reconcileFromStream } = yield* makeSettingsSynchronizer({
        initialSettings,
        materialize: materializeInstances,
      });
      yield* settingsChanges.pipe(
        Stream.runForEach(() => reconcileFromStream),
        Effect.forkScoped,
      );
    }),
  );

export const providerHostLayer = Layer.fresh(ProviderHostLive.layer);

export const layer: Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    yield* seedDevReplayInstance().pipe(
      Effect.catchCause((cause) => Effect.logWarning("Dev replay agent unavailable", cause)),
    );
    // Subscribe before the seed read so saves during registry construction are queued.
    const settingsChanges = yield* serverSettings.subscribeChanges;
    const initialSettings: ServerSettings | undefined = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const initialConfigMap =
      initialSettings === undefined
        ? ({} as ProviderInstanceConfigMap)
        : yield* materializeInstances(initialSettings).pipe(Effect.orDie);

    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: BUILT_IN_DRIVERS,
      configMap: initialConfigMap,
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(providerHostLayer),
      Layer.provide(SecretResolver.layer),
    );

    const layerSynchronized = Layer.effectContext(
      Effect.gen(function* () {
        const baseRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
        const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
        const { reconcileFromStream, synchronize } = yield* makeSettingsSynchronizer({
          initialSettings,
          materialize: materializeInstances,
        });
        yield* settingsChanges.pipe(
          Stream.runForEach(() => reconcileFromStream),
          Effect.forkScoped,
        );
        const hydratedRegistry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"] = {
          ...baseRegistry,
          get streamChanges() {
            return baseRegistry.streamChanges;
          },
          get subscribeChanges() {
            return baseRegistry.subscribeChanges;
          },
          synchronize: synchronize.pipe(Effect.andThen(baseRegistry.synchronize ?? Effect.void)),
        };
        return Context.make(
          ProviderInstanceRegistry.ProviderInstanceRegistry,
          hydratedRegistry,
        ).pipe(
          Context.add(ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator, mutator),
        );
      }),
    );

    return layerSynchronized.pipe(Layer.provide(layerMutable));
  }),
) as Layer.Layer<
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator,
  never,
  ProviderInstanceRegistryHydrationEnv
>;
