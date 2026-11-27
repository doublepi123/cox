import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  AntigravitySettings,
  ProviderDriverKind,
  ProviderSetupError,
  RuntimeMode,
  settingsSecretLiteral,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  NodeRuntimeUnavailableError,
  nodeRuntimeUnavailableMessage,
} from "@t3tools/shared/nodeRuntime";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as AcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  isAntigravityTextGenerationAvailable,
  makeAntigravityTextGeneration,
} from "../../textGeneration/AntigravityTextGeneration.ts";
import { makeAntigravityAuth, type AntigravityAuth } from "../AntigravityAuth.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import * as AntigravityUsage from "./AntigravityUsage.ts";
import {
  antigravityAuthConfigIssue,
  antigravityAuthLabel,
  antigravityAuthUsesBrowser,
  buildAntigravityAcpSpawnInput,
  isAntigravitySignInRequiredError,
  prepareAntigravityProfile,
  resolveAntigravityInstanceDirectories,
  type AntigravityAuthConfig,
} from "../antigravityAuthSupport.ts";
import {
  antigravityCliSessionMode,
  antigravityModelOptions,
  antigravityThinkingConfig,
  makeAntigravityAcpRuntime,
  antigravityServesCox,
  OPEN_MODEL_ACCESS_RELEASE,
  type AntigravityAcpRuntimeInput,
} from "../acp/AntigravityAcpSupport.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  removeAntigravityRuntimeTempDirs,
  removeAntigravitySessionFiles,
} from "../acp/AntigravitySessionFiles.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeAntigravityAdapterV2 } from "../../orchestration-v2/Adapters/AntigravityAdapterV2.ts";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { ProviderDriverError } from "../Errors.ts";
import {
  AntigravityProbeIncompatibility,
  makeAntigravityProvider,
} from "../AntigravityProvider.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { discoverAntigravitySkills, resolveAntigravityUserHome } from "./AntigravitySkills.ts";

const DRIVER = ProviderDriverKind.make("antigravity");
const decodeSettings = Schema.decodeSync(AntigravitySettings);
const isNodeRuntimeUnavailableError = Schema.is(NodeRuntimeUnavailableError);
const isAcpTransportError = Schema.is(AcpErrors.AcpTransportError);
const isProviderSetupError = Schema.is(ProviderSetupError);
const isAcpRequestError = Schema.is(AcpErrors.AcpRequestError);
const isAcpErrorDetails = Schema.is(Schema.Struct({ details: Schema.String }));
const RememberedRuntimeModes = Schema.fromJsonString(
  Schema.Struct({ authMethod: Schema.String, modes: Schema.Array(RuntimeMode) }),
);
const decodeRememberedRuntimeModes = Schema.decodeUnknownOption(RememberedRuntimeModes);
const encodeRememberedRuntimeModes = Schema.encodeSync(RememberedRuntimeModes);
const REFRESH_FAILED =
  "Could not refresh Antigravity models. The previous model list is unchanged.";
const PYTHON_SOCKS_REQUIRED = "python-socks is required to use a SOCKS proxy";

function refreshFailureDetail(cause: unknown) {
  return isAcpRequestError(cause) &&
    cause.operation === "receive-response" &&
    isAcpErrorDetails(cause.data) &&
    cause.data.details.includes(PYTHON_SOCKS_REQUIRED)
    ? `${REFRESH_FAILED} Antigravity reported: ${PYTHON_SOCKS_REQUIRED}`
    : REFRESH_FAILED;
}

export type AntigravityDriverEnv =
  | AntigravityInstallation.AntigravityInstallation
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const AntigravityDriver: ProviderDriver<
  AntigravitySettings,
  AntigravityDriverEnv,
  AntigravityUsage.AntigravityUsage
> = {
  driverKind: DRIVER,
  metadata: { displayName: "Antigravity", supportsMultipleInstances: true },
  configSchema: AntigravitySettings,
  defaultConfig: () => decodeSettings({}),
  usage: AntigravityUsage.antigravityUsageReader,
  create: Effect.fn("AntigravityDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const digest = yield* Digest.Digest;
    const random = yield* SecureRandom.SecureRandom;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const selfInvocation = yield* resolveSelfInvocation();
    const installation = yield* AntigravityInstallation.AntigravityInstallation;
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const modelCatalog = yield* ModelCatalog.ModelCatalog;
    const currentCatalog = modelCatalog.current(DRIVER);
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    const settings = { ...config, enabled } satisfies AntigravitySettings;
    const auth: AntigravityAuthConfig = {
      authMethod: settings.authMethod,
      apiKey: settingsSecretLiteral(settings.apiKey),
      gcpProject: settings.gcpProject,
      gcpLocation: settings.gcpLocation,
    };
    const authConfigIssue = antigravityAuthConfigIssue(auth);
    const processEnvironment = yield* mergeProviderInstanceEnvironment(environment);
    const userHome = resolveAntigravityUserHome(
      yield* HostProcess.Platform,
      processEnvironment,
      yield* HostProcess.HomeDirectory,
    );
    const directories = yield* resolveAntigravityInstanceDirectories(
      host.paths.stateDir,
      instanceId,
    ).pipe(
      Effect.provideService(Digest.Digest, digest),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not resolve the Antigravity profile directory.",
            cause,
          }),
      ),
    );
    const profileDirectory = directories.profile;
    // Only a session reports whether agy offers Auto, so keep the last answer across restarts.
    const runtimeModesPath = path.join(profileDirectory, "cox-runtime-modes.json");
    const rememberedRuntimeModes = yield* fileSystem.readFileString(runtimeModesPath).pipe(
      Effect.map((contents) =>
        decodeRememberedRuntimeModes(contents).pipe(
          Option.filter((saved) => saved.authMethod === auth.authMethod),
          Option.map((saved) => saved.modes),
          Option.getOrUndefined,
        ),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    for (const directory of [
      directories.runtimeTemp,
      path.join(profileDirectory, "antigravity-acp", "tmp"),
    ]) {
      yield* removeAntigravityRuntimeTempDirs(directory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      );
    }
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const classifyModels = (draft: ServerProviderDraft) =>
      currentCatalog.pipe(
        Effect.map((catalog) => stampIdentity(ModelCatalog.applyModelCatalog(draft, catalog))),
      );

    const runtimeIncompatibility = (
      executable: AntigravityInstallation.AntigravityExecutable,
      version: string,
    ) => {
      if (antigravityServesCox(version)) return undefined;
      const action =
        executable.source === "managed"
          ? "Update it in Antigravity setup"
          : `Update the Antigravity executable at ${executable.executablePath}`;
      return new ProviderSetupError({
        instanceId,
        operation: "runtime",
        detail: `Antigravity ${version} only serves allowlisted editors. ${action} to ${OPEN_MODEL_ACCESS_RELEASE} or newer, then retry.`,
      });
    };
    const externalIdentity = Effect.fn("AntigravityDriver.externalIdentity")(
      function* (executablePath: string) {
        const target = yield* fileSystem.realPath(executablePath);
        const info = yield* fileSystem.stat(target);
        return [
          executablePath,
          target,
          info.dev,
          info.ino.valueOrUndefined,
          info.size,
          info.mtime.valueOrUndefined?.getTime(),
        ]
          .map(String)
          .join("\0");
      },
      Effect.orElseSucceed(() => undefined),
    );
    let nextAttempt = 0;
    let completedAttempt = 0;
    let rejectedRuntime: { readonly identity: string; readonly version: string } | undefined;

    const makeRuntime = Effect.fn("AntigravityDriver.makeRuntime")(function* (
      input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
      observeExternalVersion = false,
    ): Effect.fn.Return<
      AcpSessionRuntime.AcpSessionRuntime["Service"],
      AcpErrors.AcpError | ProviderSetupError,
      Scope.Scope
    > {
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.acquire(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const profile = yield* prepareAntigravityProfile({
        profileDirectory,
        baseEnv: processEnvironment,
        auth,
        userHome,
        tempDirectory: directories.runtimeTemp,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError((cause) =>
          isNodeRuntimeUnavailableError(cause.cause)
            ? new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: nodeRuntimeUnavailableMessage("Antigravity sign-in"),
                cause,
              })
            : cause,
        ),
      );
      // Use one directory per process; shared cleanup could delete files another session still reads.
      // Remove after the child dies, best-effort on Windows where handles may outlive the kill;
      // the next driver start sweeps leftovers.
      const runtimeTempDirectory = yield* Effect.acquireRelease(
        fileSystem.makeTempDirectory({ directory: profile.tempDirectory, prefix: "run-" }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity runtime temp directory.",
                cause,
              }),
          ),
        ),
        (directory) =>
          fileSystem
            .remove(directory, { recursive: true, force: true })
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
              ),
            ),
      );
      const runtime = yield* makeAntigravityAcpRuntime({
        ...input,
        authMethod: auth.authMethod,
        childProcessSpawner: spawner,
        spawn: buildAntigravityAcpSpawnInput({
          installation: executable,
          profile,
          cwd: input.cwd,
          baseEnv: processEnvironment,
          auth,
          runtimeTempDirectory,
        }),
      }).pipe(Effect.provideService(SecureRandom.SecureRandom, random));
      const startCompatible = Effect.fn("AntigravityDriver.startCompatible")(function* () {
        const observe = observeExternalVersion && executable.version === null;
        const attempt = observe ? ++nextAttempt : 0;
        const identity = observe ? yield* externalIdentity(executable.executablePath) : undefined;
        const version = (yield* runtime.initialize()).agentInfo?.version;
        const cause = version ? runtimeIncompatibility(executable, version) : undefined;
        if (version && version !== "unknown" && identity && attempt > completedAttempt) {
          completedAttempt = attempt;
          rejectedRuntime = cause ? { identity, version } : undefined;
        }
        if (cause !== undefined)
          return yield* new AcpErrors.AcpTransportError({ detail: cause.detail, cause });
        return yield* runtime.start();
      });
      return {
        ...runtime,
        ...(executable.harnessPath === null
          ? {
              setMode: (modeId: string) =>
                runtime.getModeState.pipe(
                  Effect.flatMap((modeState) =>
                    runtime.setMode(antigravityCliSessionMode(modeId, modeState)),
                  ),
                ),
            }
          : {}),
        start: () =>
          startCompatible().pipe(
            Effect.tapError((cause): Effect.Effect<void> =>
              input.onAuthorizationUrl === undefined && isAntigravitySignInRequiredError(cause)
                ? provider.onAuthRequired
                : Effect.void,
            ),
          ),
      };
    });

    const makeDisposableRuntime = Effect.fn("AntigravityDriver.makeDisposableRuntime")(function* (
      input: Pick<AntigravityAcpRuntimeInput, "onAuthorizationUrl">,
    ) {
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-antigravity-setup-" })
        .pipe(
          Effect.mapError(
            () =>
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: "Could not create an Antigravity setup workspace.",
              }),
          ),
        );
      let sessionId: string | undefined;
      yield* Effect.addFinalizer(() =>
        removeAntigravitySessionFiles({
          profileDirectory,
          sessionId,
          cwd,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const runtime = yield* makeRuntime(
        {
          cwd,
          mcpServers: [],
          ...(input.onAuthorizationUrl ? { onAuthorizationUrl: input.onAuthorizationUrl } : {}),
        },
        true,
      );
      return {
        ...runtime,
        start: () =>
          runtime.start().pipe(
            Effect.tap((started) =>
              Effect.sync(() => {
                sessionId = started.sessionId;
              }),
            ),
          ),
      };
    });

    const publishCatalog = Effect.fn("AntigravityDriver.publishCatalog")(function* (
      started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
      runtime: Pick<
        AcpSessionRuntime.AcpSessionRuntime["Service"],
        "getEvents" | "drainEvents" | "setModel"
      >,
    ) {
      yield* provider.onSessionStarted(started);
      yield* Stream.runForEach(runtime.getEvents(), (event) => {
        if (event._tag === "EventStreamBarrier") {
          return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
        }
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions, { fromCatalogProbe: true });
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands)
          : Effect.void;
      }).pipe(Effect.forkScoped);
      // Thinking levels differ per model and are reported only for the selected one.
      const configOptions = started.sessionSetupResult.configOptions ?? [];
      const current = configOptions.find((option) => option.id === "model")?.currentValue;
      if (antigravityThinkingConfig(configOptions) !== undefined && typeof current === "string") {
        for (const model of [...antigravityModelOptions(configOptions), { value: current }]) {
          yield* runtime.setModel(model.value).pipe(Effect.ignore);
        }
      }
      yield* runtime.drainEvents;
    }, Effect.scoped);

    const authFlow: AntigravityAuth = yield* makeAntigravityAuth({
      instanceId,
      makeRuntime: makeDisposableRuntime,
      onAuthenticated: publishCatalog,
      onSignedOut: Effect.suspend(() => provider.onSignedOut),
      usesBrowser: antigravityAuthUsesBrowser(auth.authMethod),
    });

    // The probe must not spawn. The agent is a PyInstaller one-file bundle
    // that unpacks about 1 GB per launch, and the health check runs every
    // minute.
    const probe = Effect.gen(function* () {
      yield* modelCatalog.refreshInBackground;
      if (authConfigIssue !== null) {
        return yield* new ProviderSetupError({
          instanceId,
          operation: "configure",
          detail: authConfigIssue,
        });
      }
      const executable = yield* installation.resolve(settings.binaryPath, processEnvironment).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderSetupError({
              instanceId,
              operation: "resolve",
              detail: cause.detail,
              cause,
            }),
        ),
      );
      const previousRejection = rejectedRuntime;
      const identity =
        executable.version === null && previousRejection !== undefined
          ? yield* externalIdentity(executable.executablePath)
          : undefined;
      const rememberedVersion =
        identity !== undefined && rejectedRuntime?.identity === identity
          ? rejectedRuntime.version
          : undefined;
      const invalidatedVersion =
        previousRejection === rejectedRuntime &&
        identity !== undefined &&
        rememberedVersion === undefined
          ? previousRejection?.version
          : undefined;
      if (invalidatedVersion !== undefined || executable.version !== null)
        rejectedRuntime = undefined;
      const version = executable.version ?? rememberedVersion;
      if (version) {
        const refusal = runtimeIncompatibility(executable, version);
        if (refusal !== undefined)
          return yield* new AntigravityProbeIncompatibility({ version, detail: refusal.detail });
      }
      return {
        protocolVersion: 1,
        ...(invalidatedVersion === undefined ? {} : { invalidatedVersion }),
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: true, embeddedContext: true },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [{ id: "oauth-personal", name: "Log in with Google" }],
        agentInfo: {
          name: "antigravity-acp",
          title: "Google Antigravity",
          version: version ?? "unknown",
        },
      };
    });

    const provider = yield* makeAntigravityProvider(settings, {
      stampIdentity: classifyModels,
      probe,
      auth: { type: auth.authMethod, label: antigravityAuthLabel(auth.authMethod) },
      ...(rememberedRuntimeModes ? { rememberedRuntimeModes } : {}),
      rememberRuntimeModes: (modes) =>
        writeFileStringAtomically({
          filePath: runtimeModesPath,
          contents: encodeRememberedRuntimeModes({ authMethod: auth.authMethod, modes }),
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catch(() => Effect.logWarning("Could not save Antigravity permission modes.")),
        ),
      supportsTextGeneration: isAntigravityTextGenerationAvailable(profileDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.orElseSucceed(() => false),
      ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId,
            detail: "Could not prepare the Antigravity provider status.",
            cause,
          }),
      ),
    );
    const defaultModel = currentCatalog.pipe(Effect.map((catalog) => catalog?.defaultChatModel));
    const orchestrationAdapter = yield* makeAntigravityAdapterV2({
      profileDirectory,
      instanceId,
      selfInvocation,
      makeRuntime,
      withProcess: authFlow.withProcess,
      defaultModel,
      onSessionStarted: (started, cwd, session) =>
        provider
          .onSessionStarted(started, cwd, session)
          .pipe(Effect.andThen(authFlow.onSignedInElsewhere)),
      onSessionEvent: (event, cwd) => {
        if (event._tag === "ConfigOptionsUpdated") {
          return provider.onConfigOptionsUpdated(event.configOptions);
        }
        return event._tag === "AvailableCommandsUpdated"
          ? provider.onAvailableCommands(event.availableCommands, cwd)
          : Effect.void;
      },
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: loggers.native,
          provider: DRIVER,
          threadId,
        }),
    });
    const textGeneration = yield* makeAntigravityTextGeneration({
      profileDirectory,
      defaultModel,
      withProcess: authFlow.withProcess,
      makeRuntime: (cwd) =>
        makeRuntime({
          cwd,
          mcpServers: [],
        }),
    });

    const refreshModels = Effect.fn("AntigravityDriver.refreshModels")(
      function* () {
        const processScope = yield* Scope.make();
        yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
        yield* authFlow
          .withProcess(
            Scope.close(processScope, Exit.void),
            Effect.gen(function* () {
              const runtime = yield* makeDisposableRuntime({});
              const started = yield* runtime.start();
              yield* publishCatalog(started, runtime);
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, processScope));
      },
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: "90 seconds",
        orElse: () =>
          Effect.fail(
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Antigravity model refresh timed out. Try again or check Google sign-in.",
            }),
          ),
      }),
      Effect.tapError((cause) =>
        isAntigravitySignInRequiredError(cause) ? provider.onAuthRequired : Effect.void,
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderDriverError"
          ? cause
          : new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: isAntigravitySignInRequiredError(cause)
                ? "Sign in to Antigravity in provider settings before refreshing models."
                : cause._tag === "ProviderSetupError" &&
                    (cause.operation === "configure" ||
                      cause.operation === "resolve" ||
                      cause.operation === "start")
                  ? cause.detail
                  : isAcpTransportError(cause) &&
                      isProviderSetupError(cause.cause) &&
                      cause.cause.operation === "runtime"
                    ? cause.cause.detail
                    : refreshFailureDetail(cause),
              cause,
            }),
      ),
    );

    return {
      instanceId,
      driverKind: DRIVER,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot: provider.snapshot,
      snapshotForCwd: (cwd) =>
        !enabled
          ? provider.snapshot.getSnapshot
          : discoverAntigravitySkills({ cwd, userHome, profileDirectory }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.flatMap((skills) => provider.snapshotForCwd(cwd, skills)),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER,
                    instanceId,
                    detail: "Could not read Antigravity workspace skills.",
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
      auth: authFlow.controller,
      refreshModels,
    } satisfies ProviderInstance;
  }),
};
