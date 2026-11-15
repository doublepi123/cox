import type {
  ModelServiceError,
  ProviderInstanceConfigMap,
  ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as NodeUtil from "node:util";

import { ModelServiceGateway } from "../modelServices/ModelServiceGateway.ts";
import * as Settings from "../serverSettings.ts";
import * as ProviderInstanceRegistryMutator from "./ProviderInstanceRegistryMutator.ts";

const vaultConfigs = (settings: ServerSettings) =>
  Object.entries(settings.secretProviders).map(([id, { kind, config }]) => [id, kind, config]);

export const makeSettingsSynchronizer = Effect.fn("makeSettingsSynchronizer")(function* (input: {
  readonly initialSettings: ServerSettings | undefined;
  readonly materialize: (
    settings: ServerSettings,
  ) => Effect.Effect<ProviderInstanceConfigMap, ModelServiceError>;
}) {
  const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
  const serverSettings = yield* Settings.ServerSettingsService;
  const gateway = yield* Effect.serviceOption(ModelServiceGateway);
  const lock = yield* Semaphore.make(1);
  let secretProviders = input.initialSettings && vaultConfigs(input.initialSettings);
  let lastReconciledSettings = input.initialSettings;

  const reconcileSnapshot = Effect.fn("reconcileSnapshot")(function* (current: ServerSettings) {
    const materialized = input.materialize(current);
    const entries = yield* Option.isSome(gateway)
      ? Effect.provideService(materialized, ModelServiceGateway, gateway.value)
      : materialized;
    yield* mutator.reconcile(entries);
    const next = vaultConfigs(current);
    if (!NodeUtil.isDeepStrictEqual(secretProviders, next)) {
      yield* mutator.reloadSecrets();
      secretProviders = next;
    }
    lastReconciledSettings = current;
  });

  const reconcileFromStream = lock.withPermits(1)(
    // The subscription predates the seed read, so a queued change can be
    // older than the seed. A failed current read must leave the registry intact.
    serverSettings.getSettings.pipe(
      Effect.flatMap(reconcileSnapshot),
      Effect.catchCause((cause) =>
        Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
      ),
    ),
  );

  const synchronize = lock.withPermits(1)(
    serverSettings.getSettings.pipe(
      Effect.flatMap((current) =>
        lastReconciledSettings !== undefined &&
        NodeUtil.isDeepStrictEqual(lastReconciledSettings, current)
          ? Effect.void
          : reconcileSnapshot(current),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("ProviderInstanceRegistry synchronize failed", cause),
      ),
    ),
  );

  return { reconcileFromStream, synchronize };
});
