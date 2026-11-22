import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import { acpPermissionDisposition } from "@t3tools/provider-acp/server/clientPolicy";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";
import { CursorCliSettings } from "../settings.ts";
import {
  CURSOR_CLI_CLIENT_CAPABILITIES_META,
  CURSOR_CLI_DRIVER_KIND,
  cursorCliLaunchRuntimeMode,
  makeCursorCliAcpRuntime,
  resolveCursorCliModelId,
} from "./acpSupport.ts";
import { registerCursorCliAcpExtensions } from "./extensions.ts";
import {
  hasCursorSkillMention,
  probeCursorSkills,
  rewriteCursorSkillMentions,
} from "@t3tools/provider-cursor/server/skills";

const DEFAULT_CURSOR_CLI_SETTINGS = Schema.decodeSync(CursorCliSettings)({});

const CursorCliProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface CursorCliAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: CursorCliSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

export function makeCursorCliAcpAdapterFlavor(
  options: CursorCliAdapterV2Options,
  services: { readonly fileSystem: FileSystem.FileSystem; readonly path: Path.Path },
): AcpAdapterV2Flavor {
  return {
    driver: CURSOR_CLI_DRIVER_KIND,
    runtimeHarness: "Cursor CLI",
    capabilities: CursorCliProviderCapabilitiesV2,
    clientCapabilitiesMeta: CURSOR_CLI_CLIENT_CAPABILITIES_META,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    resolveModelId: (selection) => resolveCursorCliModelId(selection.model),
    rewriteUserText: (text, turnInput) =>
      hasCursorSkillMention(text)
        ? probeCursorSkills(turnInput.runtimePolicy.cwd ?? undefined, options.environment).pipe(
            Effect.map((skills) =>
              rewriteCursorSkillMentions(
                text,
                new Set(skills.filter((skill) => skill.enabled).map((skill) => skill.name)),
              ),
            ),
            Effect.provideService(FileSystem.FileSystem, services.fileSystem),
            Effect.provideService(Path.Path, services.path),
            Effect.orElseSucceed(() => text),
          )
        : Effect.succeed(text),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeCursorCliAcpRuntime({
          ...input,
          settings: options.settings,
          environment: { ...options.environment, ...processEnvironment },
          runtimeMode: cursorCliLaunchRuntimeMode(runtimePolicy),
        })),
    permissionDisposition: (policy, request) =>
      cursorCliLaunchRuntimeMode(policy) === "auto"
        ? "ask"
        : acpPermissionDisposition(policy, request),
    registerExtensions: registerCursorCliAcpExtensions,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeCursorCliAdapterV2 = Effect.fn("makeCursorCliAdapterV2")(function* (
  options: CursorCliAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeCursorCliAcpAdapterFlavor(options, {
      fileSystem: yield* FileSystem.FileSystem,
      path: yield* Path.Path,
    }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type CursorCliAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const CursorCliAdapterV2Driver: ProviderAdapterDriver<
  CursorCliSettings,
  CursorCliAdapterV2DriverEnv
> = {
  driverKind: CURSOR_CLI_DRIVER_KIND,
  configSchema: CursorCliSettings,
  defaultConfig: (): CursorCliSettings => DEFAULT_CURSOR_CLI_SETTINGS,
  create: Effect.fn("CursorCliAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<CursorCliSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeCursorCliAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: CURSOR_CLI_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: CURSOR_CLI_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the Cursor CLI ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
