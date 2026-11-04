import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { resolveProviderCatalog, type ModelManifestData } from "./ModelManifest.ts";
import {
  formatClaudeVersionUpgradeMessage,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogContextWindowTokens,
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
  resolveClaudeModelsForVersion,
  resolveClaudeModelSlug,
  resolveClaudeUpdateRequiredModels,
  scopeClaudeModelCatalog,
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeModelServiceCatalog,
} from "./ClaudeModelCatalog.ts";

const manifest = (): ModelManifestData => ({
  version: 1,
  currentModels: {},
  providers: {
    claudeAgent: {
      profiles: {
        synthetic: {
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "extreme", label: "Extreme", isDefault: true }],
              },
              {
                id: "contextWindow",
                label: "Context Window",
                type: "select",
                options: [
                  { id: "large", label: "Large", isDefault: true },
                  { id: "small", label: "Small" },
                ],
              },
            ],
          },
          adapter: {
            claudeCode: {
              effortMap: { extreme: "high" },
              modelSuffixes: { contextWindow: { large: "[large]" } },
            },
          },
        },
      },
      models: [
        {
          slug: "claude-synthetic-next",
          name: "Claude Synthetic Next",
          aliases: ["synthetic"],
          status: "current",
          profile: "synthetic",
          adapter: { claudeCode: { minVersion: "3.2.0" } },
        },
      ],
    },
  },
});

const CLAUDE = ProviderDriverKind.make("claudeAgent");

const catalogFromManifest = (data: ModelManifestData) =>
  resolveClaudeModelCatalog(resolveProviderCatalog(data, CLAUDE) ?? undefined);

describe("Claude model catalog", () => {
  it("keeps native Ultracode distinct from an Ultra to max alias", () => {
    const catalog = BUNDLED_CLAUDE_MODEL_CATALOG;
    for (const entry of catalog.models) {
      const effort = entry.model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
      );
      if (effort?.type !== "select") continue;
      assert.equal(
        effort.options.some((option) => option.id === "ultra"),
        false,
      );
      if (!effort.options.some((option) => option.id === "ultracode")) continue;
      assert.equal(normalizeClaudeCatalogEffort(catalog, "ultracode", entry.model.slug), "xhigh");
      assert.equal(resolveClaudeCatalogEffort(catalog, entry.model.slug, "ultracode"), "ultracode");
    }
    const declared = [{ id: "ultra", label: "Vendor Ultra", isDefault: true }];
    const bound = resolveClaudeModelServiceCatalog([
      {
        slug: "Vendor/Exact",
        capabilities: {
          optionDescriptors: [
            { id: "effort", label: "Reasoning", type: "select", options: declared },
          ],
        },
      },
    ]);
    assert.equal(normalizeClaudeCatalogEffort(bound, "ultra", "Vendor/Exact"), "ultra");
    assert.deepEqual(bound.models[0]?.model.capabilities?.optionDescriptors?.[0], {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: declared,
    });
  });

  it("does not override explicit native Ultra declarations or a disabled maximum", () => {
    const source = manifest();
    const original = source.providers!.claudeAgent!;
    for (const effortMap of [{ ultra: "xhigh" }, { max: null }] as const) {
      const catalog = catalogFromManifest({
        ...source,
        providers: {
          claudeAgent: {
            ...original,
            profiles: {
              synthetic: {
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "effort",
                      label: "Reasoning",
                      type: "select",
                      options: [{ id: "max", label: "Max", isDefault: true }],
                    },
                  ],
                },
                adapter: { claudeCode: { effortMap } },
              },
            },
          },
        },
      });
      const descriptor = catalog.models[0]?.model.capabilities?.optionDescriptors?.[0];
      assert.deepEqual(descriptor, {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "Max", isDefault: true }],
      });
    }
  });

  it("uses saved context limits for custom and overridden catalog models", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      { slug: "custom-context", capabilities: { contextWindow: 123000, supportsImages: false } },
      { slug: "claude-synthetic-next", capabilities: { contextWindow: 256000 } },
    ]);
    for (const [model, expected] of [
      ["custom-context", 123000],
      ["claude-synthetic-next", 256000],
    ] as const) {
      assert.strictEqual(
        resolveClaudeCatalogContextWindowTokens(catalog, {
          instanceId: ProviderInstanceId.make("claude"),
          model,
        }),
        expected,
      );
    }
  });
  it("resolves capacity from selected options and fixed catalog windows without guessing custom models", () => {
    const source = manifest();
    const profile = source.providers!.claudeAgent!.profiles.synthetic!;
    const catalog = catalogFromManifest({
      ...source,
      providers: {
        claudeAgent: {
          ...source.providers!.claudeAgent!,
          profiles: {
            fixed: {
              capabilities: { optionDescriptors: [] },
              adapter: { claudeCode: { fixedContextWindowTokens: 64_000 } },
            },
            synthetic: {
              ...profile,
              adapter: { claudeCode: { contextWindowTokens: { large: 1_000_000, small: 32_000 } } },
            },
          },
          models: [
            ...source.providers!.claudeAgent!.models,
            {
              slug: "fixed",
              name: "Fixed",
              status: "current",
              profile: "fixed",
            },
          ],
        },
      },
    });
    const selection = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "synthetic" };
    assert.equal(resolveClaudeCatalogContextWindowTokens(catalog, selection), 1_000_000);
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, {
        ...selection,
        options: [{ id: "contextWindow", value: "small" }],
      }),
      32_000,
    );
    assert.equal(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "fixed" }),
      64_000,
    );
    assert.isUndefined(
      resolveClaudeCatalogContextWindowTokens(catalog, { ...selection, model: "custom" }),
    );
  });

  it("filters models at runtime-version boundaries and derives the upgrade message", () => {
    const catalog = catalogFromManifest(manifest());
    assert.deepStrictEqual(resolveClaudeModelsForVersion(catalog, "3.1.9"), []);
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next"],
    );
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.1.9"), [
      { slug: "claude-synthetic-next", name: "Claude Synthetic Next", minVersion: "3.2.0" },
    ]);
    assert.deepStrictEqual(resolveClaudeUpdateRequiredModels(catalog, "3.2.0"), []);
    assert.strictEqual(
      formatClaudeVersionUpgradeMessage(catalog, "3.1.9"),
      "Claude Code v3.1.9 is too old for Claude Synthetic Next. Upgrade to v3.2.0 or newer to access it.",
    );
  });

  it("resolves aliases and declarative adapter mappings", () => {
    const base = manifest();
    const input: ModelManifestData = {
      ...base,
      providers: {
        ...base.providers,
        claudeAgent: {
          ...base.providers!.claudeAgent!,
          models: [
            {
              slug: "claude-synthetic-collision",
              name: "Claude Synthetic Collision",
              aliases: ["claude-synthetic-next"],
              status: "current",
            },
            ...base.providers!.claudeAgent!.models,
          ],
        },
      },
    };
    const catalog = catalogFromManifest(input);
    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "claude-synthetic-next");
    assert.strictEqual(
      resolveClaudeModelSlug(catalog, "claude-synthetic-next"),
      "claude-synthetic-next",
    );
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "extreme", "synthetic"), "high");
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "synthetic",
      }),
      "claude-synthetic-next[large]",
    );
  });

  it("keeps catalog options that saved capabilities leave unset for dash slugs and dot aliases", () => {
    const base = manifest();
    const catalog = scopeClaudeModelCatalog(
      catalogFromManifest({
        ...base,
        providers: {
          ...base.providers,
          claudeAgent: {
            ...base.providers!.claudeAgent!,
            models: [
              ...base.providers!.claudeAgent!.models,
              {
                slug: "claude-synthetic-5-5",
                name: "Claude Synthetic 5.5",
                aliases: ["claude-synthetic-5.5"],
                status: "current",
                profile: "synthetic",
              },
            ],
          },
        },
      }),
      [
        { slug: "claude-synthetic-5-5", capabilities: { optionDescriptors: [] } },
        { slug: "claude-synthetic-5.5", capabilities: { optionDescriptors: [] } },
        { slug: "claude-synthetic-next", capabilities: { contextWindow: 256000 } },
      ],
    );
    const selection = (model: string) => ({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model,
    });

    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-synthetic-5-5", "extreme"),
      "extreme",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, selection("claude-synthetic-5-5")),
      "claude-synthetic-5-5[large]",
    );
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "claude-synthetic-5.5", "max"), "max");
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-synthetic-next", "extreme"),
      "extreme",
    );
    assert.strictEqual(
      resolveClaudeCatalogContextWindowTokens(catalog, selection("claude-synthetic-next")),
      256000,
    );
  });

  it("appends custom models with their own descriptors and keeps bare slugs opaque", () => {
    const catalog = scopeClaudeModelCatalog(catalogFromManifest(manifest()), [
      "synthetic",
      {
        slug: "claude-custom-tuned",
        name: "Tuned",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [
                { id: "gentle", label: "Gentle", isDefault: true },
                { id: "brutal", label: "Brutal" },
              ],
            },
          ],
        },
      },
    ]);

    assert.strictEqual(resolveClaudeModelSlug(catalog, "synthetic"), "synthetic");
    assert.isUndefined(resolveClaudeCatalogEffort(catalog, "synthetic", "extreme"));
    assert.strictEqual(resolveClaudeCatalogEffort(catalog, "synthetic", "max"), "max");
    assert.strictEqual(normalizeClaudeCatalogEffort(catalog, "max", "synthetic"), "max");

    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "brutal"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogEffort(catalog, "claude-custom-tuned", "bogus"),
      "gentle",
    );
    assert.strictEqual(
      normalizeClaudeCatalogEffort(catalog, "brutal", "claude-custom-tuned"),
      "brutal",
    );
    assert.strictEqual(
      resolveClaudeCatalogApiModelId(catalog, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-custom-tuned",
        options: [{ id: "effort", value: "brutal" }],
      }),
      "claude-custom-tuned",
    );
    assert.deepStrictEqual(
      resolveClaudeModelsForVersion(catalog, "3.2.0").map((model) => model.slug),
      ["claude-synthetic-next", "claude-custom-tuned"],
    );
  });
});
