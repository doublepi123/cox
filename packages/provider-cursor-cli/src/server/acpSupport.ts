import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { CursorCliSettings } from "../settings.ts";

export const CURSOR_CLI_DRIVER_KIND = ProviderDriverKind.make("cursorCli");
export const CURSOR_CLI_DEFAULT_COMMAND = "cursor-agent";
export const CURSOR_CLI_DEFAULT_MODEL = "default";
export const CURSOR_CLI_AUTH_METHOD_ID = "cursor_login";
export const CURSOR_CLI_DOCUMENTATION_URL = "https://cursor.com/docs/cli/acp";

export const CURSOR_CLI_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export const CURSOR_CLI_CLIENT_CAPABILITIES_META = {
  parameterizedModelPicker: true,
} as const;

export const CURSOR_CLI_CLIENT_CAPABILITIES = {
  _meta: CURSOR_CLI_CLIENT_CAPABILITIES_META,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export type CursorCliLaunchSettings = Pick<CursorCliSettings, "binaryPath" | "apiEndpoint">;

export function cursorCliLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

export function cursorCliCommand(settings: Pick<CursorCliSettings, "binaryPath">): string {
  return settings.binaryPath || CURSOR_CLI_DEFAULT_COMMAND;
}

export function cursorCliGlobalArgs(
  settings: Pick<CursorCliSettings, "apiEndpoint">,
): ReadonlyArray<string> {
  return settings.apiEndpoint ? ["--endpoint", settings.apiEndpoint] : [];
}

function cursorCliPermissionArgs(runtimeMode: RuntimeMode | undefined): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto":
      return ["--auto-review"];
    case "full-access":
      return ["--force"];
    default:
      return [];
  }
}

export function cursorCliAcpArgs(
  settings: Pick<CursorCliSettings, "apiEndpoint">,
  runtimeMode?: RuntimeMode,
): ReadonlyArray<string> {
  return [...cursorCliGlobalArgs(settings), ...cursorCliPermissionArgs(runtimeMode), "acp"];
}

export function resolveCursorCliModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === "auto") return CURSOR_CLI_DEFAULT_MODEL;
  const bracket = trimmed.indexOf("[");
  return bracket === -1 ? trimmed : trimmed.slice(0, bracket);
}

interface CursorCliAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn" | "clientCapabilities"
> {
  readonly settings: CursorCliLaunchSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
}

export const makeCursorCliAcpRuntime = Effect.fn("makeCursorCliAcpRuntime")(function* (
  input: CursorCliAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { settings, environment, runtimeMode, clientCapabilities, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: cursorCliCommand(settings),
        args: [...cursorCliAcpArgs(settings, runtimeMode)],
        cwd: input.cwd,
        env: { ...environment, NO_OPEN_BROWSER: "1" },
      },
      authMethodId: CURSOR_CLI_AUTH_METHOD_ID,
      clientCapabilities: {
        ...clientCapabilities,
        _meta: { ...clientCapabilities?._meta, ...CURSOR_CLI_CLIENT_CAPABILITIES_META },
      },
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
