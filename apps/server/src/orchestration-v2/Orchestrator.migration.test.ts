import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

import { resolveProviderSessionId, shouldPrepareLegacyImportHandoff } from "./Orchestrator.ts";

it.effect(
  "moves old shared sessions to distinct reusable sessions when isolation becomes required",
  () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const providerInstanceId = ProviderInstanceId.make("bound-codex");
      const shared = idAllocator.derive.providerSession({ providerInstanceId });
      const adapter = {
        getCapabilities: () =>
          Effect.succeed({
            ...CodexProviderCapabilitiesV2,
            sessions: {
              ...CodexProviderCapabilitiesV2.sessions,
              supportsMultipleProviderThreadsPerSession: false,
            },
          }),
      };
      const first = yield* resolveProviderSessionId({
        adapter,
        idAllocator,
        providerInstanceId,
        threadId: ThreadId.make("first"),
        existingProviderSessionId: shared,
      });
      const second = yield* resolveProviderSessionId({
        adapter,
        idAllocator,
        providerInstanceId,
        threadId: ThreadId.make("second"),
        existingProviderSessionId: shared,
      });
      assert.notEqual(first, shared);
      assert.notEqual(first, second);
      assert.equal(
        yield* resolveProviderSessionId({
          adapter,
          idAllocator,
          providerInstanceId,
          threadId: ThreadId.make("first"),
          existingProviderSessionId: first,
        }),
        first,
      );
      assert.equal(
        yield* resolveProviderSessionId({
          idAllocator,
          providerInstanceId,
          threadId: ThreadId.make("third"),
          existingProviderSessionId: shared,
          adapter: { getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2) },
        }),
        shared,
      );
    }).pipe(Effect.provide(IdAllocator.layer.pipe(Layer.provide(NodeServices.layer)))),
);

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
});
