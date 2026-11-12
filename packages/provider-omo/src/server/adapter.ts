import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
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
import { OmoSettings } from "../settings.ts";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { prepareOmoConfiguration } from "./configuration.ts";
import { buildOmoLaunch, materializeOmoExtension } from "./extension.ts";
import { makeOmoRpcConnection } from "./runtime.ts";
import { omoTodoSnapshot } from "./todo.ts";

export const OMO_DRIVER = ProviderDriverKind.make("omo");
const decodeOmoSettings = Schema.decodeSync(OmoSettings);
export type OmoAdapterEnv = PiAdapterV2DriverEnv | Path.Path;

export const OmoAdapterDriver: ProviderAdapterDriver<OmoSettings, OmoAdapterEnv> = {
  driverKind: OMO_DRIVER,
  configSchema: OmoSettings,
  defaultConfig: () => decodeOmoSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const hostEnvironment = yield* HostProcess.Environment;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const environment = yield* mergeProviderInstanceEnvironment(
        input.environment,
        hostEnvironment,
      );
      const configured = yield* prepareOmoConfiguration(
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
          driver: OMO_DRIVER,
          label: "OMO",
          connect: makeOmoRpcConnection,
          materializeExtension: materializeOmoExtension,
          buildLaunch: buildOmoLaunch,
          nativeSubagents: { requestName: "cox.omo.tasks" },
          todo: {
            requestName: "cox.omo.todo",
            eventName: "cox.omo.todo.updated",
            toolNames: ["todo", "todowrite"],
            decode: omoTodoSnapshot,
          },
          capabilities: {
            ...PiProviderCapabilitiesV2,
            planning: {
              ...PiProviderCapabilitiesV2.planning,
              emitsPlanUpdated: true,
              emitsTodoList: true,
              planDeltasHaveItemIds: true,
            },
            approvals: {
              ...PiProviderCapabilitiesV2.approvals,
              approvalsCanOriginateFromSubagents: true,
            },
          },
        },
      });
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: OMO_DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to create the OMO Native adapter.",
            cause,
          }),
      ),
    ),
};
