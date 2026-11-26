import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@t3tools/shared/nodeRuntime";
import { type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import { readCustomModelEntries } from "@t3tools/shared/model";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import type * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
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
import { DshSettings } from "../settings.ts";
import { extractDshElicitationForm } from "./elicitation.ts";
import {
  DSH_DRIVER_KIND,
  dshPermissionMode,
  dshProposedPlanMarkdown,
  dshRuntimeLaunch,
  withDshModelServicePatch,
  makeDshAcpRuntime,
  resolveDshModelValue,
  type DshRuntimeLaunch,
} from "./acpSupport.ts";

const DEFAULT_DSH_SETTINGS = Schema.decodeSync(DshSettings)({});

export const DshProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
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
} satisfies OrchestrationV2ProviderCapabilities;

export interface DshAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: DshSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly launch: DshRuntimeLaunch;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
}

export function makeDshAcpAdapterFlavor(options: DshAdapterV2Options): AcpAdapterV2Flavor {
  return {
    driver: DSH_DRIVER_KIND,
    runtimeHarness: "DeepSeek Harness",
    capabilities: DshProviderCapabilitiesV2,
    customModels: readCustomModelEntries(options.settings.customModels).map((entry) => entry.slug),
    resolveModelId: (selection) => resolveDshModelValue(selection.model),
    extractElicitationForm: extractDshElicitationForm,
    registerExtensions: ({ runtime, captureProposedPlan }) =>
      runtime.handleSessionUpdate(({ update }) => {
        if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") {
          return Effect.void;
        }
        const planMarkdown = dshProposedPlanMarkdown(update);
        return planMarkdown === undefined ? Effect.void : captureProposedPlan({ planMarkdown });
      }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeDshAcpRuntime({
          ...input,
          launch: options.launch,
          environment: {
            ...options.environment,
            ...processEnvironment,
            DSH_PERMISSION_MODE: dshPermissionMode(runtimePolicy),
          },
        })),
  };
}

export const makeDshAdapterV2 = Effect.fn("makeDshAdapterV2")(function* (
  options: DshAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeDshAcpAdapterFlavor(options),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
  });
});

export type DshAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const DshAdapterV2Driver: ProviderAdapterDriver<DshSettings, DshAdapterV2DriverEnv> = {
  driverKind: DSH_DRIVER_KIND,
  configSchema: DshSettings,
  defaultConfig: (): DshSettings => DEFAULT_DSH_SETTINGS,
  create: Effect.fn("DshAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<DshSettings>) {
      const host = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeDshAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: yield* mergeProviderInstanceEnvironment(
          input.environment,
          yield* HostProcess.Environment,
        ),
        launch: withDshModelServicePatch(
          dshRuntimeLaunch({
            baseDir: host.paths.baseDir,
            platform: yield* HostProcess.Platform,
            join: (...segments) => path.join(...segments),
          }),
          input.config,
        ),
        selfInvocation,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: DSH_DRIVER_KIND,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: DSH_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create the DeepSeek Harness ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};
