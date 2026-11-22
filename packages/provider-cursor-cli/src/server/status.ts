import {
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import {
  buildServerProvider,
  isCommandMissingCause,
  nonEmptyTrimmed,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { CursorCliSettings } from "../settings.ts";
import {
  CURSOR_CLI_DEFAULT_MODEL,
  CURSOR_CLI_DRIVER_KIND,
  CURSOR_CLI_SUPPORTED_RUNTIME_MODES,
  cursorCliCommand,
  cursorCliGlobalArgs,
  makeCursorCliAcpRuntime,
} from "./acpSupport.ts";

const CURSOR_CLI_PRESENTATION = {
  displayName: "Cursor CLI",
  showInteractionModeToggle: true,
  supportedRuntimeModes: CURSOR_CLI_SUPPORTED_RUNTIME_MODES,
} as const;

const DISCOVERY_TIMEOUT = "30 seconds";
const ABOUT_TIMEOUT_MS = 15_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const SIGN_IN_MESSAGE =
  "Sign in to Cursor CLI from Cox, run `cursor-agent login`, or set CURSOR_API_KEY for this provider.";

const AboutPayload = Schema.fromJsonString(
  Schema.Struct({
    cliVersion: Schema.optional(Schema.NullOr(Schema.String)),
    latestVersion: Schema.optional(Schema.NullOr(Schema.String)),
    subscriptionTier: Schema.optional(Schema.NullOr(Schema.String)),
    userEmail: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
const decodeAboutPayload = Schema.decodeUnknownOption(AboutPayload);

const CursorConfigOptionBase = {
  id: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  category: Schema.optionalKey(Schema.NullOr(Schema.String)),
} as const;
const CursorConfigOption = Schema.Union([
  Schema.Struct({
    ...CursorConfigOptionBase,
    type: Schema.Literal("select"),
    currentValue: Schema.String,
    options: Schema.Array(
      Schema.Struct({
        value: Schema.String,
        name: Schema.String,
        description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    ),
  }),
  Schema.Struct({
    ...CursorConfigOptionBase,
    type: Schema.Literal("boolean"),
    currentValue: Schema.Boolean,
  }),
]);
const decodeCursorConfigOption = Schema.decodeUnknownOption(CursorConfigOption);

export const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      name: Schema.String,
      configOptions: Schema.optional(Schema.Array(Schema.Unknown)),
    }),
  ),
});
const decodeListAvailableModels = Schema.decodeUnknownOption(CursorListAvailableModelsResponse);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export interface CursorCliAbout {
  readonly version: string | null;
  readonly latestVersion: string | null;
  readonly email: string | undefined;
  readonly subscriptionTier: string | undefined;
}

export function parseCursorCliAbout(stdout: string): CursorCliAbout | undefined {
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  return Option.getOrUndefined(
    decodeAboutPayload(stdout.slice(start)).pipe(
      Option.map((payload) => ({
        version: nonEmptyTrimmed(payload.cliVersion ?? undefined) ?? null,
        latestVersion: nonEmptyTrimmed(payload.latestVersion ?? undefined) ?? null,
        email: nonEmptyTrimmed(payload.userEmail ?? undefined),
        subscriptionTier: nonEmptyTrimmed(payload.subscriptionTier ?? undefined),
      })),
    ),
  );
}

const defaultModel = (): ServerProviderModel => ({
  slug: CURSOR_CLI_DEFAULT_MODEL,
  name: "Auto",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
});

export function cursorCliModelsFromAvailableModels(
  response: unknown,
): ReadonlyArray<ServerProviderModel> {
  const decoded = decodeListAvailableModels(response);
  if (Option.isNone(decoded)) return [defaultModel()];
  const seen = new Set<string>();
  const models: Array<ServerProviderModel> = [];
  for (const model of decoded.value.models) {
    const slug = model.value.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const optionDescriptors = acpProviderOptionDescriptors({
      configOptions: (model.configOptions ?? []).flatMap((option) =>
        Option.toArray(decodeCursorConfigOption(option)),
      ),
      modeState: undefined,
    });
    models.push({
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      ...(slug === CURSOR_CLI_DEFAULT_MODEL ? { isDefault: true } : {}),
      capabilities: createModelCapabilities({ optionDescriptors }),
    });
  }
  return seen.has(CURSOR_CLI_DEFAULT_MODEL) ? models : [defaultModel(), ...models];
}

const snapshot = (
  settings: CursorCliSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  models: ReadonlyArray<ServerProviderModel> = [defaultModel()],
): ServerProviderDraft =>
  buildServerProvider({
    driver: CURSOR_CLI_DRIVER_KIND,
    presentation: CURSOR_CLI_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(models, settings.customModels, EMPTY_CAPABILITIES),
    probe,
  });

export const buildInitialCursorCliProviderSnapshot = (
  settings: CursorCliSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Cursor CLI availability..."
        : "Cursor CLI is disabled in Cox settings.",
    }),
  );

const runAbout = Effect.fn("runCursorCliAbout")(function* (
  settings: CursorCliSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = cursorCliCommand(settings);
  const args = [...cursorCliGlobalArgs(settings), "about", "--format", "json"];
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: { ...environment, NO_COLOR: "1", NO_OPEN_BROWSER: "1" },
      shell: spawnCommand.shell,
      stdin: "ignore",
    }),
  );
});

export type CursorCliModelDiscovery =
  | { readonly _tag: "Discovered"; readonly models: ReadonlyArray<ServerProviderModel> }
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Failed"; readonly detail: string };

export const discoverCursorCliModels = Effect.fn("discoverCursorCliModels")(function* (
  settings: CursorCliSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  CursorCliModelDiscovery,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const result = yield* Effect.gen(function* () {
    const runtime = yield* makeCursorCliAcpRuntime({
      settings,
      environment,
      cwd,
      clientInfo: { name: "cox-provider-status", version: "0.0.0" },
      authenticateOnAuthRequired: false,
    });
    yield* runtime.initialize();
    return yield* runtime.request("cursor/list_available_models", {});
  }).pipe(Effect.timeoutOption(DISCOVERY_TIMEOUT), Effect.result);
  if (Result.isFailure(result)) {
    const failure = result.failure;
    if (isAcpRequestError(failure) && failure.code === -32000) return { _tag: "Unauthenticated" };
    return {
      _tag: "Failed",
      detail: isAcpRequestError(failure)
        ? failure.errorMessage
        : "The Cursor CLI ACP server failed.",
    };
  }
  if (Option.isNone(result.success)) {
    return { _tag: "Failed", detail: "Cursor CLI model discovery timed out." };
  }
  return { _tag: "Discovered", models: cursorCliModelsFromAvailableModels(result.success.value) };
});

export function withCursorCliVersionAdvisory(
  draft: ServerProviderDraft,
  about: CursorCliAbout,
  checkedAt: string,
): ServerProviderDraft {
  if (about.version === null || about.latestVersion === null) return draft;
  return {
    ...draft,
    versionAdvisory: {
      status: about.latestVersion === about.version ? "current" : "behind_latest",
      currentVersion: about.version,
      latestVersion: about.latestVersion,
      updateCommand: null,
      canUpdate: false,
      checkedAt,
      message: null,
    },
  };
}

function authFromAbout(about: CursorCliAbout | undefined, usesApiKey: boolean): ServerProviderAuth {
  return {
    status: "authenticated",
    ...(usesApiKey
      ? { type: "apiKey", label: "Cursor API key" }
      : about?.subscriptionTier
        ? { type: about.subscriptionTier, label: `Cursor ${about.subscriptionTier}` }
        : {}),
    ...(about?.email ? { email: about.email } : {}),
  };
}

function snapshotFromDiscovery(
  settings: CursorCliSettings,
  checkedAt: string,
  about: CursorCliAbout,
  usesApiKey: boolean,
  discovery: CursorCliModelDiscovery,
): ServerProviderDraft {
  switch (discovery._tag) {
    case "Discovered":
      return snapshot(
        settings,
        checkedAt,
        {
          installed: true,
          version: about.version,
          status: "ready",
          auth: authFromAbout(about, usesApiKey),
        },
        discovery.models,
      );
    case "Unauthenticated":
      return snapshot(settings, checkedAt, {
        installed: true,
        version: about.version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: SIGN_IN_MESSAGE,
      });
    case "Failed":
      return snapshot(settings, checkedAt, {
        installed: true,
        version: about.version,
        status: usesApiKey ? "error" : "warning",
        auth:
          !usesApiKey && about.email !== undefined
            ? authFromAbout(about, false)
            : { status: "unknown" },
        message: usesApiKey
          ? `Cursor CLI rejected the configured CURSOR_API_KEY or could not start (${discovery.detail}).`
          : `Cursor CLI model discovery failed (${discovery.detail}). Model options may be incomplete.`,
      });
  }
}

export const checkCursorCliProviderStatus = Effect.fn("checkCursorCliProviderStatus")(function* (
  settings: CursorCliSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Cursor CLI is disabled in Cox settings.",
    });
  }

  const aboutResult = yield* runAbout(settings, environment).pipe(
    Effect.timeoutOption(ABOUT_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(aboutResult) || Option.isNone(aboutResult.success)) {
    const missing = Result.isFailure(aboutResult) && isCommandMissingCause(aboutResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Cursor CLI is not installed. Install it from Cox or see https://cursor.com/docs/cli/installation."
        : "Failed to run `cursor-agent about`.",
    });
  }
  const aboutOutput = aboutResult.success.value;
  const about = parseCursorCliAbout(aboutOutput.stdout);
  if (aboutOutput.code !== 0 || about === undefined) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version: about?.version ?? null,
      status: "error",
      auth: { status: "unknown" },
      message: "Cursor CLI is installed but `cursor-agent about` failed.",
    });
  }

  const usesApiKey = Boolean(environment.CURSOR_API_KEY?.trim());
  const discovery = yield* discoverCursorCliModels(settings, environment, cwd).pipe(Effect.scoped);
  return withCursorCliVersionAdvisory(
    snapshotFromDiscovery(settings, checkedAt, about, usesApiKey, discovery),
    about,
    checkedAt,
  );
});
