import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { makeClaudeQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeModelServiceCatalog,
} from "./ClaudeModelCatalog.ts";
import { checkClaudeProviderStatus, makePendingClaudeProvider } from "./ClaudeProvider.ts";
import { mergeProviderSnapshot } from "./ProviderRegistry.ts";
import { hydrateCachedProvider } from "./providerStatusCache.ts";

const customModels = [
  { slug: "vendor/unknown", name: "Unknown metadata" },
  {
    slug: "sonnet",
    name: "Service Sonnet",
    capabilities: { contextWindow: 64000, supportsImages: false, optionDescriptors: [] },
  },
];
const catalog = resolveClaudeModelServiceCatalog(customModels, "sonnet");
const settings = Schema.decodeSync(ClaudeSettings)({
  binaryPath: "/missing-cox-model-service-claude",
  baseUrl: "http://127.0.0.1:3773/api/model-gateway/v1",
  apiKey: "local-test-token",
  customModels,
});

it.layer(NodeServices.layer)("Claude model service", (it) => {
  it.effect("replaces old models and metadata when binding, editing, or unbinding a service", () =>
    Effect.gen(function* () {
      const pending = yield* makePendingClaudeProvider(settings, catalog);
      const bound: ServerProvider = {
        ...pending,
        instanceId: ProviderInstanceId.make("claude-service"),
        driver: ProviderDriverKind.make("claudeAgent"),
        modelCatalogSource: "model-service",
      };
      const native: ServerProvider = {
        ...bound,
        modelCatalogSource: "provider",
        models: [
          { slug: "claude-native", name: "Claude Native", isCustom: false, capabilities: null },
        ],
      };
      const edited: ServerProvider = {
        ...bound,
        models: [{ ...bound.models[0]!, capabilities: null }],
      };
      for (const [previous, next] of [
        [native, bound],
        [bound, edited],
        [bound, native],
      ] as const) {
        assert.deepEqual(mergeProviderSnapshot(previous, next).models, next.models);
        assert.deepEqual(
          hydrateCachedProvider({ cachedProvider: previous, fallbackProvider: next }).models,
          next.models,
        );
      }
      const cachedMetadata: ServerProvider = {
        ...bound,
        models: [
          { ...edited.models[0]!, capabilities: { contextWindow: 1000000, supportsImages: true } },
        ],
      };
      assert.isNull(mergeProviderSnapshot(cachedMetadata, edited).models[0]?.capabilities);
    }),
  );

  it.effect("uses only bound models in initial and checked snapshots before CLI installation", () =>
    Effect.gen(function* () {
      const pending = yield* makePendingClaudeProvider(settings, catalog);
      const checked = yield* checkClaudeProviderStatus(settings, undefined, {}, undefined, catalog);
      for (const snapshot of [pending, checked]) {
        assert.deepEqual(
          snapshot.models.map((model) => model.slug),
          ["vendor/unknown", "sonnet"],
        );
        assert.strictEqual(snapshot.models.find((model) => model.isDefault)?.slug, "sonnet");
        assert.isNull(snapshot.models[0]?.capabilities);
        assert.strictEqual(snapshot.models[1]?.capabilities?.contextWindow, 64000);
        assert.isFalse(snapshot.models[1]?.capabilities?.supportsImages);
      }
    }),
  );

  it("preserves exact service IDs without resolving them as built-in Claude aliases", () => {
    const selection = { instanceId: ProviderInstanceId.make("claude-service"), model: "sonnet" };
    const options = makeClaudeQueryOptions({
      modelSelection: selection,
      modelCatalog: catalog,
      nativeThreadId: "test-native-thread",
      resume: false,
      cwd: "/workspace",
      settings,
    });
    assert.strictEqual(options.model, "sonnet");
    assert.strictEqual(resolveClaudeCatalogContextWindowTokens(catalog, selection), 64000);
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "vendor/unknown" }),
    );
    assert.deepEqual(resolveClaudeModelServiceCatalog([], "sonnet").models, []);
  });
});
