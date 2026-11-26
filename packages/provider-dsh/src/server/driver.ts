import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeManualOnlyProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { DshSettings } from "../settings.ts";
import {
  DSH_DOCUMENTATION_URL,
  DSH_DRIVER_KIND,
  DSH_VERSION,
  withDshModelServicePatch,
} from "./acpSupport.ts";
import { DshAdapterV2Driver, type DshAdapterV2DriverEnv } from "./adapter.ts";
import { makeDshInstallation } from "./installation.ts";
import { buildInitialDshProviderSnapshot, checkDshProviderStatus } from "./status.ts";
import { makeDshTextGeneration } from "./textGeneration.ts";
import { dshUsageReader } from "./usage.ts";
import { discoverDshSkills } from "./skills.ts";
import { listDshSessions } from "./sessions.ts";

const decodeDshSettings = Schema.decodeSync(DshSettings);
const MAINTENANCE = {
  ...makeManualOnlyProviderMaintenanceCapabilities({
    provider: DSH_DRIVER_KIND,
    packageName: null,
  }),
  lookupLatestVersion: Effect.succeed(DSH_VERSION),
  latestVersionCacheKey: `dsh-${DSH_VERSION}`,
  compareVersions: compareSemverVersions,
};

export type DshDriverEnv =
  | DshAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

export const DshDriver: ProviderDriver<DshSettings, DshDriverEnv, Path.Path> = {
  driverKind: DSH_DRIVER_KIND,
  metadata: {
    displayName: "DeepSeek Harness",
    supportsMultipleInstances: true,
  },
  configSchema: DshSettings,
  defaultConfig: (): DshSettings => decodeDshSettings({}),
  usage: dshUsageReader,
  create: Effect.fn("DshDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const http = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const effectiveConfig = { ...config, enabled } satisfies DshSettings;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const processEnv = yield* mergeProviderInstanceEnvironment(
      environment,
      yield* HostProcess.Environment,
    );
    const installation = yield* makeDshInstallation({
      instanceId,
      baseDir: host.paths.baseDir,
      environment: processEnv,
      onChanged: Effect.suspend((): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid)),
    });
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DSH_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DSH_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const stampSnapshot = (draft: Parameters<typeof stampIdentity>[0]) =>
      stampIdentity({
        ...draft,
        setup: {
          canAuthenticate: false,
          canInstall: true,
          documentationUrl: DSH_DOCUMENTATION_URL,
        },
      });
    const orchestrationAdapter = yield* DshAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config: effectiveConfig,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DSH_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the DeepSeek Harness orchestration adapter.",
            cause,
          }),
      ),
    );
    const launch = withDshModelServicePatch(installation.launch, effectiveConfig);
    const textGeneration = yield* makeDshTextGeneration(launch, processEnv);
    const checkProvider = checkDshProviderStatus({
      settings: effectiveConfig,
      environment: processEnv,
      cwd: host.paths.cwd,
      launch,
      version: installation.installedVersion,
    }).pipe(
      Effect.map(stampSnapshot),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<DshSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialDshProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        snapshot.versionAdvisory?.latestVersion
          ? Effect.void
          : enrichProviderSnapshotWithVersionAdvisory(snapshot, MAINTENANCE, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }).pipe(
              Effect.provideService(HttpClient.HttpClient, http),
              Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
              Effect.flatMap(publishSnapshot),
            ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DSH_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the DeepSeek Harness provider snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: DSH_DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (cwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverDshSkills(cwd, processEnv, processEnv.HOME || homeDirectory).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
      installation,
      acpSessionManagement: {
        listSessions: ({ cwd, cursor }) =>
          listDshSessions({
            launch,
            environment: processEnv,
            cwd,
            ...(cursor === undefined ? {} : { cursor }),
          }).pipe(
            Effect.provideService(SecureRandom.SecureRandom, random),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
      },
    } satisfies ProviderInstance;
  }),
};
