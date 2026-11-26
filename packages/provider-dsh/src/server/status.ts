import {
  type ModelCapabilities,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as EffectAcpErrors from "effect-acp/errors";
import * as Schema from "effect/Schema";

import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import {
  buildServerProvider,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { DshSettings } from "../settings.ts";
import {
  DSH_DRIVER_KIND,
  DSH_SUPPORTED_RUNTIME_MODES,
  dshModelSlug,
  makeDshAcpRuntime,
  type DshRuntimeLaunch,
} from "./acpSupport.ts";
import { withDshEphemeralSessions } from "./ephemeralSessions.ts";

const DSH_PRESENTATION = {
  displayName: "DeepSeek Harness",
  showInteractionModeToggle: true,
  supportedRuntimeModes: DSH_SUPPORTED_RUNTIME_MODES,
} as const;

const PROBE_TIMEOUT = "90 seconds";
const COMMAND_GRACE = "3 seconds";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const isAcpError = Schema.is(EffectAcpErrors.AcpRequestError);

export const DSH_CREDENTIALS_MESSAGE =
  "DeepSeek Harness has no usable model. Set DEEPSEEK_API_KEY for this provider, or configure a model in the DeepSeek Harness home.";

export function dshModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const model = findModelConfigOption(configOptions);
  if (model === undefined) return [];
  const capabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({ configOptions, modeState: undefined }),
  });
  const seen = new Set<string>();
  return flattenSelectChoices(model.options).flatMap(({ value, name }) => {
    const slug = dshModelSlug(value);
    if (seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: name.trim() || slug,
        isCustom: false,
        ...(value === model.currentValue ? { isDefault: true } : {}),
        capabilities,
      },
    ];
  });
}

export function dshSlashCommands(
  commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const seen = new Set<string>();
  return commands.flatMap((command) => {
    const name = command.name.trim();
    if (!name || seen.has(name.toLowerCase())) return [];
    seen.add(name.toLowerCase());
    const description = command.description?.trim();
    const hint = command.input && "hint" in command.input ? command.input.hint.trim() : "";
    return [
      {
        name,
        ...(description ? { description } : {}),
        ...(hint ? { input: { hint } } : {}),
      },
    ];
  });
}

const snapshot = (
  settings: DshSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel> = [],
  slashCommands: ReadonlyArray<ServerProviderSlashCommand> = [],
): ServerProviderDraft =>
  buildServerProvider({
    driver: DSH_DRIVER_KIND,
    presentation: DSH_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(models, settings.customModels, EMPTY_CAPABILITIES),
    slashCommands,
    probe,
  });

export const buildInitialDshProviderSnapshot = (
  settings: DshSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking DeepSeek Harness..."
        : "DeepSeek Harness is disabled in Cox settings.",
    }),
  );

const probeRuntime = Effect.fn("probeDshRuntime")(function* (
  launch: DshRuntimeLaunch,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) {
  const commands = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>([]);
  const advertised = yield* Deferred.make<void>();
  const runtime = yield* withDshEphemeralSessions((patch) =>
    makeDshAcpRuntime({
      launch,
      environment,
      cwd,
      extraPatches: [patch],
      clientInfo: { name: "cox-provider-status", version: "0.0.0" },
    }),
  );
  yield* runtime.handleSessionUpdate((notification) =>
    notification.update.sessionUpdate === "available_commands_update"
      ? Ref.set(commands, notification.update.availableCommands).pipe(
          Effect.andThen(Deferred.succeed(advertised, undefined)),
          Effect.asVoid,
        )
      : Effect.void,
  );
  const started = yield* runtime.start();
  yield* Deferred.await(advertised).pipe(Effect.timeoutOption(COMMAND_GRACE));
  return {
    models: dshModelsFromConfigOptions(started.sessionSetupResult.configOptions),
    commands: dshSlashCommands(yield* Ref.get(commands)),
  };
});

export const checkDshProviderStatus = Effect.fn("checkDshProviderStatus")(function* (input: {
  readonly settings: DshSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly launch: DshRuntimeLaunch;
  readonly version: Effect.Effect<string | null>;
}): Effect.fn.Return<
  ServerProviderDraft,
  never,
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | Path.Path
> {
  const { settings } = input;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "DeepSeek Harness is disabled in Cox settings.",
    });
  }
  const version = yield* input.version;
  if (version === null) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "DeepSeek Harness is not installed. Install it from Cox.",
    });
  }
  const result = yield* probeRuntime(input.launch, input.environment, input.cwd).pipe(
    Effect.scoped,
    Effect.timeoutOption(PROBE_TIMEOUT),
    Effect.result,
  );
  if (Result.isFailure(result) || Option.isNone(result.success)) {
    const detail = Result.isFailure(result)
      ? isAcpError(result.failure)
        ? result.failure.errorMessage
        : "the ACP bridge did not start"
      : "the ACP bridge did not answer in time";
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `DeepSeek Harness could not start (${detail}).`,
    });
  }
  const { models, commands } = result.success.value;
  if (models.length === 0) {
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: DSH_CREDENTIALS_MESSAGE,
      },
      [],
      commands,
    );
  }
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      status: "ready",
      auth: input.launch.configPatches?.length
        ? { status: "authenticated", type: "modelService", label: "Cox model service" }
        : input.environment.DEEPSEEK_API_KEY?.trim()
          ? { status: "authenticated", type: "apiKey", label: "DeepSeek API key" }
          : { status: "unknown" },
    },
    models,
    commands,
  );
});
