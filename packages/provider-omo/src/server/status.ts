import type { ServerProviderModel } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  configuredPiLaunchArgs,
  EMPTY_PI_MODEL_CAPABILITIES,
  piModelCapabilities,
  parsePiDiscoveredCommands,
  withPiBuiltinSlashCommands,
} from "@t3tools/provider-pi/server";
import type { OmoSettings } from "../settings.ts";
import { buildOmoLaunch } from "./extension.ts";
import { makeOmoRpcConnection } from "./runtime.ts";
import { OMO_VERSION } from "./configuration.ts";

const presentation = {
  displayName: "OMO Native",
  showInteractionModeToggle: false,
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
} as const;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function modelsFromSettings(
  settings: OmoSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [],
) {
  return providerModelsFromSettings(
    settings.modelServiceManaged
      ? discovered
      : [
          {
            slug: "default",
            name: "OMO default",
            isCustom: false,
            capabilities: EMPTY_PI_MODEL_CAPABILITIES,
          },
          ...discovered,
        ],
    settings.customModels,
    EMPTY_PI_MODEL_CAPABILITIES,
  );
}

export const initialOmoSnapshot = Effect.fn("initialOmoSnapshot")(function* (
  settings: OmoSettings,
) {
  return buildServerProvider({
    presentation,
    enabled: settings.enabled,
    checkedAt: DateTime.formatIso(yield* DateTime.now),
    models: modelsFromSettings(settings),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking OMO Native availability..."
        : "OMO Native is disabled in Cox settings.",
    },
  });
});

export const checkOmoStatus = Effect.fn("checkOmoStatus")(function* (
  settings: OmoSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  extensionPath?: string,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (!settings.enabled) return yield* initialOmoSnapshot(settings);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  let installedVersion: string | null = null;
  const fallback = (message: string, installed = false, version: string | null = null) =>
    buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings),
      probe: { installed, version, status: "warning", auth: { status: "unknown" }, message },
    });
  const probe = yield* Effect.gen(function* () {
    const binary = settings.binaryPath || "omo";
    const resolved = yield* resolveSpawnCommand(binary, ["--version"], { env: environment });
    const output = yield* spawnAndCollect(
      binary,
      ChildProcess.make(resolved.command, resolved.args, {
        env: environment,
        extendEnv: false,
        shell: resolved.shell,
      }),
    );
    const version = output.code === 0 ? parseGenericCliVersion(output.stdout) : null;
    installedVersion = version;
    if (!version)
      return fallback(
        "OMO Native is not installed. Install it in Cox or select the official omo binary.",
      );
    if (version !== OMO_VERSION)
      return fallback(
        `Cox currently supports the verified OMO Native ${OMO_VERSION} runtime. Select that version or install it in Cox.`,
        true,
        version,
      );
    const args = configuredPiLaunchArgs(settings);
    if (!args.ok) return fallback(args.message, true, version);
    const launch = buildOmoLaunch({
      launchArgs: args.args,
      environment,
      mcpSession: undefined,
      extensionPath,
      ephemeral: true,
      shortLived: true,
      disableTools: true,
    });
    const connection = yield* makeOmoRpcConnection({ command: binary, ...launch, cwd });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const inventory = record(yield* connection.request({ type: "get_available_models" }));
    const discovered: Array<ServerProviderModel> = [];
    for (const value of Array.isArray(inventory.models) ? inventory.models : []) {
      const model = record(value);
      if (typeof model.provider !== "string" || typeof model.id !== "string") continue;
      if (settings.modelServiceManaged && model.provider !== "cox") continue;
      discovered.push({
        slug: `${model.provider}/${model.id}`,
        name: typeof model.name === "string" ? model.name : model.id,
        subProvider: model.provider,
        isCustom: false,
        capabilities: piModelCapabilities(model, undefined),
      });
    }
    const commands = parsePiDiscoveredCommands(
      yield* connection.request({ type: "get_commands" }).pipe(Effect.orElseSucceed(() => ({}))),
    );
    return buildServerProvider({
      presentation,
      enabled: true,
      checkedAt,
      models: modelsFromSettings(settings, discovered),
      ...commands,
      slashCommands: withPiBuiltinSlashCommands(commands.slashCommands),
      probe: {
        installed: true,
        version,
        status: discovered.length ? "ready" : "warning",
        auth: { status: discovered.length ? "authenticated" : "unauthenticated", type: "omo" },
        ...(discovered.length
          ? {}
          : { message: "Configure a model service binding or OMO Native model credentials." }),
      },
    });
  }).pipe(
    Effect.scoped,
    Effect.timeout("30 seconds"),
    Effect.orElseSucceed(() =>
      fallback(
        "Cox could not start OMO Native. Check the installation and model configuration.",
        installedVersion !== null,
        installedVersion,
      ),
    ),
  );
  return probe;
});
