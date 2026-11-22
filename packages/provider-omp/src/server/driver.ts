import * as Effect from "effect/Effect";
import type { ServerProvider } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
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
import { makePiTextGeneration } from "@t3tools/provider-pi/server";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import { OmpSettings } from "../settings.ts";
import { OMP_DRIVER, OmpAdapterDriver, type OmpAdapterEnv } from "./adapter.ts";
import { prepareOmpConfiguration } from "./configuration.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  discoverOmpCommandsForCwd,
  enrichOmpSnapshot,
} from "./status.ts";
import { buildOmpLaunch } from "./extension.ts";
import { makeOmpInstallation } from "./installation.ts";
import { makeOmpRpcConnection } from "./runtime.ts";
import { ompUsageReader } from "./usage.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);

export type OmpDriverEnv =
  | OmpAdapterEnv
  | SecureRandom.SecureRandom
  | Path.Path
  | FileSystem.FileSystem
  | ChildProcessSpawner.ChildProcessSpawner
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ProviderHost.ProviderHost;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv, Path.Path> = {
  driverKind: OMP_DRIVER,
  metadata: {
    displayName: "Oh My Pi",
    supportsMultipleInstances: true,
  },
  usage: ompUsageReader,
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const installation = yield* makeOmpInstallation({
        instanceId: input.instanceId,
        baseDir: host.paths.baseDir,
        ...(input.config.binaryPath ? { binaryPath: input.config.binaryPath } : {}),
        environment: yield* mergeProviderInstanceEnvironment(input.environment),
        onChanged: Effect.suspend((): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid)),
      });
      const prepared = yield* prepareOmpConfiguration(
        { ...input.config, enabled: input.enabled },
        installation.environment,
        host.paths.baseDir,
        input.instanceId,
      );
      const config = prepared.settings;
      const environment = prepared.environment;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: OMP_DRIVER,
        instanceId: input.instanceId,
      });
      const stamp = (draft: ServerProviderDraft): ServerProvider => ({
        ...draft,
        instanceId: input.instanceId,
        driver: OMP_DRIVER,
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        setup: {
          canInstall: !input.config.binaryPath || input.config.binaryPath === "omp",
          canAuthenticate: false,
          documentationUrl: "https://github.com/can1357/oh-my-pi",
        },
      });

      const resolveMaintenance = () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: OMP_DRIVER,
            packageName: "@oh-my-pi/pi-coding-agent",
            installPath: installation.executablePath,
          }),
        );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(config);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stamp)),
        checkProvider: checkOmpProviderStatus(config, environment, host.paths.cwd).pipe(
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichOmpSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                ...(settings.enableProviderUpdateChecks === undefined
                  ? {}
                  : { enableProviderUpdateChecks: settings.enableProviderUpdateChecks }),
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: OMP_DRIVER,
              instanceId: input.instanceId,
              detail: "Failed to build the Oh My Pi snapshot.",
              cause,
            }),
        ),
      );

      const adapter = yield* OmpAdapterDriver.create({
        ...input,
        config,
        environment: [
          ...input.environment,
          ...Object.entries(environment).flatMap(([name, value]) =>
            name === installation.pathKey && value !== undefined
              ? [{ name, value, sensitive: false }]
              : [],
          ),
        ],
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

      const textGeneration = yield* makePiTextGeneration(config, environment, {
        label: "Oh My Pi",
        connect: makeOmpRpcConnection,
        buildLaunch: buildOmpLaunch,
      });

      return {
        instanceId: input.instanceId,
        driverKind: OMP_DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        snapshot,
        snapshotForCwd: (workspaceCwd) =>
          !config.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                discoverOmpCommandsForCwd(config, environment, workspaceCwd).pipe(
                  Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: OMP_DRIVER,
                        instanceId: input.instanceId,
                        detail: "Failed to discover Oh My Pi workspace commands.",
                        cause,
                      }),
                  ),
                ),
              ]).pipe(
                Effect.map(([machineSnapshot, commands]) => ({
                  ...machineSnapshot,
                  ...commands,
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
            driver: OMP_DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to initialize Oh My Pi.",
            cause,
          }),
      ),
    ),
};
