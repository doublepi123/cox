import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as CursorAgentSdk from "@t3tools/provider-cursor/server/CursorAgentSdk";
import * as CursorAgentSdkProcessRunner from "@t3tools/provider-cursor/server/CursorAgentSdkProcessRunner";
import * as CursorSdk from "@t3tools/provider-cursor/server/CursorSdk";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | IdAllocator.IdAllocatorV2;

const resolveCursorWorkerLaunch = Effect.gen(function* () {
  const path = yield* Path.Path;
  const command = yield* HostProcess.ExecutablePath;
  const isExecutable = yield* HostProcess.IsExecutable;
  const entry = yield* path
    .fromFileUrl(
      new URL(import.meta.url.endsWith(".ts") ? "../bin.ts" : "./bin.mjs", import.meta.url),
    )
    .pipe(Effect.orDie);
  return { command, args: [...(isExecutable ? [] : [entry]), "__cursor-sdk-worker"] };
});

/** Reuse the continuation worker's exact layer reference so memoization shares one queue. */
export const layer = Layer.mergeAll(
  ClaudeAdapterV2.layerQueryRunner,
  CodexAdapterV2.layerAppServerClientFactory,
  Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return CursorAgentSdkProcessRunner.layer(
        resolveCursorWorkerLaunch.pipe(Effect.provideService(Path.Path, path)),
      );
    }),
  ),
  CursorSdk.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
);
