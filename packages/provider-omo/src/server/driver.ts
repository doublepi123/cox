import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  makeProviderSnapshotSettingsSource,
  haveProviderSnapshotSettingsChanged,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import { makePiInstallation, makePiTextGeneration } from "@t3tools/provider-pi/server";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { OmoSettings } from "../settings.ts";
import { OMO_DRIVER, OmoAdapterDriver, type OmoAdapterEnv } from "./adapter.ts";
import { prepareOmoConfiguration, OMO_VERSION } from "./configuration.ts";
import { initialOmoSnapshot, checkOmoStatus } from "./status.ts";
import { buildOmoLaunch, materializeOmoExtension } from "./extension.ts";
import { makeOmoRpcConnection } from "./runtime.ts";
import { omoUsageReader } from "./usage.ts";
const decodeOmoSettings = Schema.decodeSync(OmoSettings);

export type OmoDriverEnv =
  | OmoAdapterEnv
  | Crypto.Crypto
  | Path.Path
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderHost.ProviderHost;

export const OmoDriver: ProviderDriver<OmoSettings, OmoDriverEnv, Path.Path> = {
  driverKind: OMO_DRIVER,
  metadata: { displayName: "OMO Native", supportsMultipleInstances: true },
  usage: omoUsageReader,
  configSchema: OmoSettings,
  defaultConfig: () => decodeOmoSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const installation = yield* makePiInstallation({
        instanceId: input.instanceId,
        baseDir: host.paths.baseDir,
        binaryPath: input.config.binaryPath,
        environment: yield* mergeProviderInstanceEnvironment(input.environment),
        onChanged: Effect.suspend((): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid)),
        runtime: {
          driver: "omo",
          command: "omo",
          label: "OMO Native",
          packageName: "omo-ai",
          version: OMO_VERSION,
          minimumVersion: OMO_VERSION,
        },
      });
      const prepared = yield* prepareOmoConfiguration(
        { ...input.config, enabled: input.enabled },
        installation.environment,
        host.paths.baseDir,
        input.instanceId,
      );
      const config = prepared.settings;
      const environment = prepared.environment;
      const extensionPath = config.enabled
        ? yield* materializeOmoExtension(host.paths.providerStatusCacheDir)
        : undefined;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: OMO_DRIVER,
        instanceId: input.instanceId,
      });
      const stamp = (draft: ServerProviderDraft): ServerProvider => ({
        ...draft,
        instanceId: input.instanceId,
        driver: OMO_DRIVER,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        setup: {
          canInstall: !input.config.binaryPath || input.config.binaryPath === "omo",
          canAuthenticate: false,
          documentationUrl: "https://github.com/code-yeongyu/oh-my-openagent",
        },
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(config);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmoSettings>>({
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({
              provider: OMO_DRIVER,
              packageName: "omo-ai",
              installPath: installation.executablePath,
            }),
          ),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          initialOmoSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOmoStatus(config, environment, host.paths.cwd, extensionPath).pipe(
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      });
      const adapter = yield* OmoAdapterDriver.create({
        ...input,
        config,
        environment: [
          ...input.environment,
          {
            name: installation.pathKey,
            value: environment[installation.pathKey]!,
            sensitive: false,
          },
        ],
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
      const textGeneration = yield* makePiTextGeneration(config, environment, {
        label: "OMO Native",
        connect: makeOmoRpcConnection,
        buildLaunch: buildOmoLaunch,
      });
      return {
        instanceId: input.instanceId,
        driverKind: OMO_DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        snapshotForCwd: (cwd) =>
          !config.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                checkOmoStatus(config, environment, cwd, extensionPath).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                ),
              ]).pipe(
                Effect.map(([current, workspace]) => ({
                  ...current,
                  slashCommands: workspace.slashCommands,
                  skills: workspace.skills,
                  slashCommandsPending: false,
                })),
              ),
        orchestrationAdapter: adapter,
        textGeneration,
        installation,
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: OMO_DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to initialize OMO Native.",
            cause,
          }),
      ),
    ),
};
