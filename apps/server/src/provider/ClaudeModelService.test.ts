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
import { modelServiceAgentCapabilities } from "@t3tools/shared/modelServices";

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
  it.effect("keeps ultra in provider snapshots and supplies it without unsupported SDK flags", () =>
    Effect.gen(function* () {
      const capabilities = modelServiceAgentCapabilities("claudeAgent", {
        contextWindow: 1000000,
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            currentValue: "ultra",
            options: [
              { id: "high", label: "High" },
              { id: "ultra", label: "Ultra", isDefault: true },
            ],
          },
        ],
      })!;
      const models = [{ slug: "gpt-service-model", capabilities }];
      const catalog = resolveClaudeModelServiceCatalog(models);
      const pending = yield* makePendingClaudeProvider(
        { ...settings, customModels: models },
        catalog,
      );
      assert.deepEqual(
        pending.models[0]?.capabilities?.optionDescriptors,
        capabilities.optionDescriptors,
      );
      for (const effort of ["high", "ultra"]) {
        const options = makeClaudeQueryOptions({
          modelSelection: {
            instanceId: ProviderInstanceId.make("claude-service"),
            model: "gpt-service-model",
            options: [{ id: "effort", value: effort }],
          },
          modelCatalog: catalog,
          nativeThreadId: "service-effort-thread",
          resume: false,
          cwd: "/workspace",
          settings,
          environment: { PATH: "/test/bin", CLAUDE_CODE_EXTRA_BODY: '{"process_setting":true}' },
          sdkSettings: {
            env: {
              KEPT: "settings",
              CLAUDE_CODE_EXTRA_BODY:
                '{"metadata":{"source":"test"},"output_config":{"format":{"type":"json"}}}',
            },
          },
        });
        assert.isUndefined(options.effort);
        assert.equal(options.env?.PATH, "/test/bin");
        const extraBody = JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY!);
        assert.deepEqual(extraBody, {
          metadata: { source: "test" },
          output_config: { format: { type: "json" }, effort },
        });
        assert.isObject(options.settings);
        if (typeof options.settings === "object") {
          assert.equal(options.settings.env?.KEPT, "settings");
          assert.equal(
            options.settings.env?.CLAUDE_CODE_EXTRA_BODY,
            options.env?.CLAUDE_CODE_EXTRA_BODY,
          );
        }
      }
    }),
  );

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
