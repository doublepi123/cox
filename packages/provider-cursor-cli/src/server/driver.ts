import * as HostProcess from "@t3tools/shared/HostProcess";
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
  homebrewOwnershipFromCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveHomebrewProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "@t3tools/provider-cursor/server/skills";
import { CursorCliSettings } from "../settings.ts";
import {
  CURSOR_CLI_DEFAULT_COMMAND,
  CURSOR_CLI_DOCUMENTATION_URL,
  CURSOR_CLI_DRIVER_KIND,
} from "./acpSupport.ts";
import { CursorCliAdapterV2Driver, type CursorCliAdapterV2DriverEnv } from "./adapter.ts";
import { makeCursorCliAuth } from "./auth.ts";
import { makeCursorCliInstallation } from "./installation.ts";
import { buildInitialCursorCliProviderSnapshot, checkCursorCliProviderStatus } from "./status.ts";
import { makeCursorCliTextGeneration } from "./textGeneration.ts";

const decodeCursorCliSettings = Schema.decodeSync(CursorCliSettings);
const OFFICIAL_INSTALL_PATH = /\/cursor-agent\/versions\/[^/]+\/cursor-agent(?:\.exe)?$/u;
const manualMaintenance = (installPath?: string) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider: CURSOR_CLI_DRIVER_KIND,
    packageName: null,
    ...(installPath ? { installPath } : {}),
  });
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("resolveCursorCliMaintenance")(function* (context) {
    if (!context) return manualMaintenance();
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    if (homebrew?.kind === "cask") {
      return (
        (yield* resolveHomebrewProviderMaintenance(
          { provider: CURSOR_CLI_DRIVER_KIND, packageName: null },
          homebrew,
          context,
        )) ?? manualMaintenance(context.realCommandPath)
      );
    }
    if (!OFFICIAL_INSTALL_PATH.test(normalizeCommandPath(context.realCommandPath)))
      return manualMaintenance(context.realCommandPath);
    return makeProviderMaintenanceCapabilities({
      provider: CURSOR_CLI_DRIVER_KIND,
      packageName: null,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["update"],
      updateLockKey: "cursor-cli",
      platform: context.platform,
      env: { ...context.env, NO_COLOR: "1", NO_OPEN_BROWSER: "1" },
    });
  }),
};
const compareCursorCliVersions = (current: string, latest: string) => {
  if (current === latest) return 0;
  return current.slice(0, 10) > latest.slice(0, 10) ? 1 : -1;
};

export type CursorCliDriverEnv =
  | CursorCliAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path;

export const CursorCliDriver: ProviderDriver<CursorCliSettings, CursorCliDriverEnv> = {
  driverKind: CURSOR_CLI_DRIVER_KIND,
  metadata: {
    displayName: "Cursor CLI",
    supportsMultipleInstances: true,
  },
  configSchema: CursorCliSettings,
  defaultConfig: (): CursorCliSettings => decodeCursorCliSettings({}),
  create: Effect.fn("CursorCliDriver.create")(function* ({
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
    const effectiveConfig = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
    } satisfies CursorCliSettings;
    const installation = yield* makeCursorCliInstallation({
      instanceId,
      baseDir: host.paths.baseDir,
      binaryPath: effectiveConfig.binaryPath,
      environment: yield* mergeProviderInstanceEnvironment(
        environment,
        yield* HostProcess.Environment,
      ),
      onChanged: Effect.suspend((): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid)),
    });
    const processEnv = installation.environment;
    const usesApiKey = Boolean(processEnv.CURSOR_API_KEY?.trim());
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: CURSOR_CLI_DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: CURSOR_CLI_DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const stampSnapshot = (draft: Parameters<typeof stampIdentity>[0]) =>
      stampIdentity({
        ...draft,
        setup: {
          canAuthenticate: !usesApiKey,
          canInstall: effectiveConfig.binaryPath === CURSOR_CLI_DEFAULT_COMMAND,
          documentationUrl: CURSOR_CLI_DOCUMENTATION_URL,
        },
        auth: { ...draft.auth, canLogout: !usesApiKey },
      });
    const auth = yield* makeCursorCliAuth({
      instanceId,
      settings: effectiveConfig,
      enabled,
      environment: processEnv,
      canStart: installation.isInstalling.pipe(Effect.map((installing) => !installing)),
      onChanged: Effect.suspend((): Effect.Effect<void> => snapshot.refresh.pipe(Effect.asVoid)),
    });
    const orchestrationAdapter = yield* CursorCliAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment: [
        ...environment,
        { name: installation.pathKey, value: processEnv[installation.pathKey]!, sensitive: false },
      ],
      enabled,
      config: effectiveConfig,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: CURSOR_CLI_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Cursor CLI orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeCursorCliTextGeneration(effectiveConfig, processEnv);
    const checkProvider = checkCursorCliProviderStatus(
      effectiveConfig,
      processEnv,
      host.paths.cwd,
    ).pipe(
      Effect.map(stampSnapshot),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      }).pipe(
        Effect.map((capabilities): ProviderMaintenanceCapabilities =>
          capabilities.lookupLatestVersion
            ? capabilities
            : {
                ...capabilities,
                lookupLatestVersion: installation.latestVersion,
                latestVersionCacheKey: "cursor-cli-install-script",
                compareVersions: compareCursorCliVersions,
              },
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorCliSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialCursorCliProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
      checkProvider,
      enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenance) =>
            enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenance, {
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          Effect.flatMap(publishSnapshot),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: CURSOR_CLI_DRIVER_KIND,
            instanceId,
            detail: "Failed to build the Cursor CLI provider snapshot.",
            cause,
          }),
      ),
    );

    return {
      instanceId,
      driverKind: CURSOR_CLI_DRIVER_KIND,
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
              probeCursorSkills(cwd, processEnv).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
                Effect.provideService(Path.Path, path),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: CURSOR_CLI_DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Cursor skills for '${cwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
      orchestrationAdapter,
      textGeneration,
      auth,
      installation,
    } satisfies ProviderInstance;
  }),
};
