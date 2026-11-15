import { ProviderDriverKind, type OrchestrationV2ProviderCapabilities } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  makePiAdapterV2,
  PiProviderCapabilitiesV2,
  type PiAdapterV2DriverEnv,
} from "@t3tools/provider-pi/server";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
} from "@t3tools/provider-core/server/adapterDriver";
import { OmpSettings } from "../settings.ts";
import { prepareOmpConfiguration } from "./configuration.ts";
import { buildOmpLaunch, materializeOmpExtension } from "./extension.ts";
import { makeOmpRpcConnection } from "./runtime.ts";
import { ompTodoSnapshot } from "./todo.ts";

export const OMP_DRIVER = ProviderDriverKind.make("omp");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);
export type OmpAdapterEnv = PiAdapterV2DriverEnv | Path.Path;

const OMP_CAPABILITIES = {
  ...PiProviderCapabilitiesV2,
  runtimePolicy: { enforcement: "native" },
  planning: {
    ...PiProviderCapabilitiesV2.planning,
    emitsTodoList: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export const OmpAdapterDriver: ProviderAdapterDriver<OmpSettings, OmpAdapterEnv> = {
  driverKind: OMP_DRIVER,
  configSchema: OmpSettings,
  defaultConfig: () => decodeOmpSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        hostEnvironment,
      );
      const configured = yield* prepareOmpConfiguration(
        { ...input.config, enabled: input.enabled },
        environment,
        host.paths.baseDir,
        input.instanceId,
      );
      return yield* makePiAdapterV2({
        instanceId: input.instanceId,
        ...configured,
        continuationRequests,
        runtime: {
          driver: OMP_DRIVER,
          label: "Oh My Pi",
          connect: makeOmpRpcConnection,
          materializeExtension: materializeOmpExtension,
          buildLaunch: buildOmpLaunch,
          nativeSubagents: { requestName: "cox.omp.tasks" },
          todo: {
            requestName: "cox.omp.todo",
            eventName: "cox.omp.todo.updated",
            toolNames: ["todo"],
            decode: ompTodoSnapshot,
          },
          capabilities: OMP_CAPABILITIES,
        },
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: OMP_DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to create the Oh My Pi adapter.",
            cause,
          }),
      ),
    ),
};
