import {
  type CustomModelSetting,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { OmpSettings } from "../settings.ts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { EMPTY_PI_MODEL_CAPABILITIES, piModelCapabilities } from "@t3tools/provider-pi/server";
import { PiRpcError, PiRpcTimeoutError } from "@t3tools/provider-pi/server";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  parseOmpDiscoveredCommands,
  withOmpBuiltinSlashCommands,
  type OmpDiscoveredCommands,
} from "./commands.ts";
import { configuredOmpLaunchArgs, ompEnvironment, MINIMUM_OMP_VERSION } from "./configuration.ts";
import { buildOmpLaunch } from "./extension.ts";
import { makeOmpRpcConnection } from "./runtime.ts";

const OMP_PRESENTATION = {
  displayName: "Oh My Pi",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const OMP_RPC_DISCOVERY_TIMEOUT_MS = 30_000;
export { MINIMUM_OMP_VERSION };

function recordField(input: unknown, key: string): unknown {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function recordString(input: unknown, key: string): string | undefined {
  const value = recordField(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Oh My Pi default",
  isCustom: false,
  capabilities: EMPTY_PI_MODEL_CAPABILITIES,
};

interface OmpDiscovery extends Pick<OmpDiscoveredCommands, "slashCommands" | "skills"> {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly authenticated: boolean;
  readonly unavailableActiveModel: { readonly provider: string; readonly id: string } | undefined;
}

function ompModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...discovered],
    customModels ?? [],
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

export function parseOmpDiscoveredModels(
  data: unknown,
  state: unknown,
  liveThinkingLevels?: ReadonlyArray<string> | undefined,
): Result.Result<ReadonlyArray<ServerProviderModel>, PiRpcError> {
  const models = recordField(data, "models");
  if (!Array.isArray(models)) {
    return Result.fail(
      new PiRpcError({ operation: "get_available_models", detail: "Invalid model inventory" }),
    );
  }
  const activeModel = recordField(state, "model");
  const activeProvider = recordString(activeModel, "provider");
  const activeModelId = recordString(activeModel, "id");
  const seen = new Set<string>();
  const parsed: Array<ServerProviderModel> = [];
  for (const model of models) {
    const provider = recordString(model, "provider");
    const id = recordString(model, "id");
    if (provider === undefined || id === undefined || provider.trim() === "" || id.trim() === "") {
      return Result.fail(
        new PiRpcError({ operation: "get_available_models", detail: "Invalid model identity" }),
      );
    }
    const slug = `${provider}/${id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const isActive = provider === activeProvider && id === activeModelId;
    const liveLevelMap =
      isActive && liveThinkingLevels !== undefined
        ? Object.fromEntries(
            ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
              level,
              liveThinkingLevels.includes(level) ? level : null,
            ]),
          )
        : undefined;
    parsed.push({
      slug,
      name: recordString(model, "name") ?? slug,
      subProvider: provider,
      isCustom: false,
      capabilities: piModelCapabilities(
        liveLevelMap === undefined
          ? model
          : { ...model, reasoning: true, thinkingLevelMap: liveLevelMap },
        isActive ? recordString(state, "thinkingLevel") : undefined,
      ),
    });
  }
  return Result.succeed(parsed);
}

const makeOmpDiscoveryConnection = Effect.fnUntraced(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const launch = buildOmpLaunch({
    launchArgs,
    environment,
    mcpSession: undefined,
    extensionPath: undefined,
    ephemeral: true,
    shortLived: true,
  });
  const connection = yield* makeOmpRpcConnection({
    command: ompSettings.binaryPath || "omp",
    args: launch.args,
    cwd,
    env: ompEnvironment(ompSettings, launch.env),
  });
  yield* Stream.fromQueue(connection.events).pipe(
    Stream.runDrain,
    Effect.ignore,
    Effect.forkScoped,
  );
  return connection;
});

const discoverOmpViaRpc = Effect.fn("OmpProviderStatus.discoverOmpViaRpc")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  launchArgs: ReadonlyArray<string>,
  cwd?: string,
) {
  const connection = yield* makeOmpDiscoveryConnection(ompSettings, environment, launchArgs, cwd);
  const stateData = yield* connection.request({ type: "get_state" });
  const modelsData = yield* connection.request({ type: "get_available_models" });
  const commandsData = yield* connection
    .request({ type: "get_available_commands" })
    .pipe(Effect.orElseSucceed(() => undefined));
  const thinkingData = yield* connection
    .request({ type: "get_available_thinking_levels" })
    .pipe(Effect.orElseSucceed(() => undefined));
  const liveThinkingLevels = Array.isArray(recordField(thinkingData, "levels"))
    ? (recordField(thinkingData, "levels") as ReadonlyArray<unknown>).filter(
        (level): level is string => typeof level === "string",
      )
    : undefined;
  const discoveredModels = yield* Effect.fromResult(
    parseOmpDiscoveredModels(modelsData, stateData, liveThinkingLevels),
  );
  const { slashCommands, skills } = parseOmpDiscoveredCommands(commandsData);
  const activeModel = recordField(stateData, "model");
  const activeProvider = recordString(activeModel, "provider");
  const activeModelId = recordString(activeModel, "id");
  return {
    models: discoveredModels,
    slashCommands: withOmpBuiltinSlashCommands(slashCommands),
    skills,
    authenticated: discoveredModels.length > 0,
    unavailableActiveModel:
      activeProvider !== undefined &&
      activeModelId !== undefined &&
      !discoveredModels.some((model) => model.subProvider === activeProvider)
        ? { provider: activeProvider, id: activeModelId }
        : undefined,
  } satisfies OmpDiscovery;
}, Effect.scoped);

export const discoverOmpCommandsForCwd = Effect.fn("discoverOmpCommandsForCwd")(
  function* (ompSettings: OmpSettings, environment: NodeJS.ProcessEnv, cwd: string) {
    const launchArgs = configuredOmpLaunchArgs(ompSettings);
    if (!launchArgs.ok) {
      return yield* new PiRpcError({ operation: "launch", detail: launchArgs.message });
    }
    const connection = yield* makeOmpDiscoveryConnection(
      ompSettings,
      environment,
      launchArgs.args,
      cwd,
    );
    const commandsData = yield* connection.request({ type: "get_available_commands" });
    const { slashCommands, skills } = parseOmpDiscoveredCommands(commandsData);
    return { slashCommands: withOmpBuiltinSlashCommands(slashCommands), skills };
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: OMP_RPC_DISCOVERY_TIMEOUT_MS,
    orElse: () =>
      Effect.fail(
        new PiRpcTimeoutError({ operation: "discovery", timeoutMs: OMP_RPC_DISCOVERY_TIMEOUT_MS }),
      ),
  }),
);

const runOmpVersionCommand = Effect.fn("OmpProviderStatus.runOmpVersionCommand")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = ompSettings.binaryPath || "omp";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
    env: environment,
  });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const buildInitialOmpProviderSnapshot = Effect.fn(
  "OmpProviderStatus.buildInitialOmpProviderSnapshot",
)(function* (ompSettings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
  const models = ompModelsFromSettings(ompSettings.customModels);
  if (!ompSettings.enabled) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Oh My Pi is disabled in Cox settings.",
      },
    });
  }
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Checking Oh My Pi availability...",
    },
  });
});

export const checkOmpProviderStatus = Effect.fn("checkOmpProviderStatus")(function* (
  ompSettings: OmpSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = ompModelsFromSettings(ompSettings.customModels);
  const notInstalled = (message: string) =>
    buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message,
      },
    });

  if (!ompSettings.enabled) {
    return notInstalled("Oh My Pi is disabled in Cox settings.");
  }

  const versionResult = yield* runOmpVersionCommand(ompSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Oh My Pi health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "The omp CLI is not installed or not on PATH. Install Oh My Pi in Cox settings."
          : "Failed to execute the Oh My Pi health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi is installed but timed out while running `omp --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Oh My Pi is installed but failed to run.",
      },
    });
  }

  if (version === null) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: `Cox could not determine the Oh My Pi version. Oh My Pi ${MINIMUM_OMP_VERSION} or newer is required.`,
      },
    });
  }

  if (compareSemverVersions(version, MINIMUM_OMP_VERSION) < 0) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Oh My Pi ${version} is unsupported. Update to Oh My Pi ${MINIMUM_OMP_VERSION} or newer.`,
      },
    });
  }

  const resolvedLaunchArgs = configuredOmpLaunchArgs(ompSettings);
  if (!resolvedLaunchArgs.ok) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: resolvedLaunchArgs.message,
      },
    });
  }

  const discoveryExit = yield* discoverOmpViaRpc(
    ompSettings,
    environment,
    resolvedLaunchArgs.args,
    cwd,
  ).pipe(Effect.timeoutOption(OMP_RPC_DISCOVERY_TIMEOUT_MS), Effect.exit);
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Oh My Pi RPC discovery failed.", {
      errorTag: causeErrorTag(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Oh My Pi is available, but Cox could not refresh its models and commands. The live session will retry startup.",
      },
    });
  }
  if (Option.isNone(discoveryExit.value)) {
    return buildServerProvider({
      presentation: OMP_PRESENTATION,
      enabled: ompSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "ready",
        auth: { status: "unknown" },
        message:
          "Oh My Pi is available, but model and command discovery needs interactive input. The live session will handle it.",
      },
    });
  }

  const discovery = discoveryExit.value.value;
  const models = ompModelsFromSettings(ompSettings.customModels, discovery.models);
  const message = !discovery.authenticated
    ? "Oh My Pi has no usable models. Configure a model provider and API key in Cox settings, or run `omp` in a terminal and use its login flow."
    : discovery.unavailableActiveModel === undefined
      ? undefined
      : `Oh My Pi default (${discovery.unavailableActiveModel.provider}/${discovery.unavailableActiveModel.id}) uses ${discovery.unavailableActiveModel.provider}, which has no available models in Oh My Pi. Choose another model, or check that provider's setup and the Oh My Pi launch arguments.`;
  return buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: ompSettings.enabled,
    checkedAt,
    models,
    slashCommands: discovery.slashCommands,
    skills: discovery.skills,
    probe: {
      installed: true,
      version,
      status: discovery.authenticated ? "ready" : "warning",
      auth: { status: discovery.authenticated ? "authenticated" : "unauthenticated", type: "omp" },
      ...(message === undefined ? {} : { message }),
    },
  });
});

export const enrichOmpSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
}) => {
  const { snapshot, publishSnapshot } = input;
  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Oh My Pi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
