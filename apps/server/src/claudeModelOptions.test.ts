import { describe, expect, it } from "@effect/vitest";

import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import {
  claudeRequestEffortEnvironment,
  compileClaudeModelSelection,
} from "./claudeModelOptions.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeModelServiceCatalog,
  scopeClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";
import { makeClaudeQueryOptions } from "./orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const selection = (
  model: string,
  options: NonNullable<ModelSelection["options"]>,
): ModelSelection => ({
  instanceId: ProviderInstanceId.make("claude_test"),
  model,
  options,
});

describe("compileClaudeModelSelection", () => {
  it("runs Ultracode at the chosen effort and reads the old Ultracode effort as xhigh", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [
          { id: "effort", value: "high" },
          { id: "ultracode", value: true },
        ]),
      ),
    ).toMatchObject({ effort: "high", settings: { ultracode: true } });
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }]),
      ),
    ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    const legacyTurnedOff = compileClaudeModelSelection(
      selection("claude-opus-5-5", [
        { id: "effort", value: "ultracode" },
        { id: "ultracode", value: false },
      ]),
    );
    expect(legacyTurnedOff.effort).toBe("xhigh");
    expect(legacyTurnedOff.settings.ultracode).toBe(false);
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "effort", value: "high" }]))
        .settings,
    ).not.toHaveProperty("ultracode");
  });

  it("keeps old Ultracode defaults and selections at Extra High on custom models", () => {
    const customModel = (slug: string, choices: ReadonlyArray<string>) => ({
      slug,
      name: slug,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            currentValue: "ultracode",
            options: choices.map((id) => ({ id, label: id, isDefault: id === "ultracode" })),
          },
        ],
      },
    });
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      customModel("claude-custom-tuned", ["high", "xhigh", "ultracode"]),
      customModel("claude-custom-no-xhigh", ["high", "ultracode"]),
    ]);

    for (const model of ["claude-custom-tuned", "claude-custom-no-xhigh"]) {
      expect(compileClaudeModelSelection(selection(model, []), catalog)).toMatchObject({
        effort: "xhigh",
        settings: { ultracode: true },
      });
      expect(
        compileClaudeModelSelection(
          selection(model, [{ id: "effort", value: "ultracode" }]),
          catalog,
        ),
      ).toMatchObject({ effort: "xhigh", settings: { ultracode: true } });
    }
  });

  it("compiles native Claude Ultracode as a workflow mode rather than an Ultra to max alias", () => {
    const selected = selection("claude-opus-5-5", [{ id: "effort", value: "ultracode" }]);
    const compiled = compileClaudeModelSelection(selected);
    expect(compiled).toMatchObject({
      effort: "xhigh",
      nativeEffort: "xhigh",
      requestEffort: undefined,
    });
    expect(compiled.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
    expect(selected.options).toEqual([{ id: "effort", value: "ultracode" }]);
    const options = makeClaudeQueryOptions({
      modelSelection: selected,
      nativeThreadId: "native-claude-ultra",
      resume: false,
      cwd: null,
    });
    expect(options.effort).toBe("xhigh");
    expect(options.env?.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
    expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
  });

  it.each(["ultracode", "ultra"])(
    "keeps a service's explicit %s effort separate from legacy workflow selections",
    (mode) => {
      const catalog = resolveClaudeModelServiceCatalog([
        {
          slug: "gpt-6.1-sol",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: [
                  { id: "high", label: "High" },
                  { id: "xhigh", label: "Extra High" },
                  { id: "max", label: "Max" },
                  { id: "ultra", label: "Old Ultra", isDefault: true },
                ],
              },
            ],
          },
        },
      ]);
      const selected = selection("gpt-6.1-sol", [{ id: "effort", value: mode }]);
      const compiled = compileClaudeModelSelection(selected, catalog);
      expect(compiled).toMatchObject({
        nativeEffort: undefined,
        requestEffort: mode === "ultracode" ? "xhigh" : "ultra",
        settings: mode === "ultracode" ? { ultracode: true, enableWorkflows: true } : {},
      });
      const options = makeClaudeQueryOptions({
        modelSelection: selected,
        modelCatalog: catalog,
        nativeThreadId: "bound-workflow",
        resume: false,
        cwd: null,
      });
      expect(options.effort).toBeUndefined();
      if (mode === "ultracode")
        expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
      else expect(options.settings).not.toHaveProperty("ultracode");
      expect(JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY!)).toEqual({
        output_config: { effort: mode === "ultracode" ? "xhigh" : "ultra" },
      });
      expect(selected.options?.[0]?.value).toBe(mode);
    },
  );

  it.each(["low", "high", "vendor-effort", undefined])(
    "enables workflows independently for a service with effort %s and no xhigh",
    (effort) => {
      const catalog = resolveClaudeModelServiceCatalog([
        {
          slug: "no-xhigh",
          capabilities: effort
            ? {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    options: ["low", "high", "vendor-effort"].map((id) => ({
                      id,
                      label: id,
                      isDefault: id === "high",
                    })),
                  },
                ],
              }
            : {},
        },
      ]);
      const selected = selection("no-xhigh", [
        ...(effort ? [{ id: "effort", value: effort }] : []),
        { id: "ultracode", value: true },
      ]);
      const compiled = compileClaudeModelSelection(selected, catalog);
      expect(compiled).toMatchObject({
        nativeEffort: undefined,
        effort,
        requestEffort: effort,
        settings: { ultracode: true, enableWorkflows: true },
      });
      const options = makeClaudeQueryOptions({
        modelSelection: selected,
        modelCatalog: catalog,
        nativeThreadId: "independent-ultracode",
        resume: false,
        cwd: null,
      });
      expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
      expect(options.effort).toBeUndefined();
      if (effort)
        expect(JSON.parse(options.env!.CLAUDE_CODE_EXTRA_BODY!)).toEqual({
          output_config: { effort },
        });
      else expect(options.env?.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
      const off = compileClaudeModelSelection(
        selection("no-xhigh", [
          ...(effort ? [{ id: "effort", value: effort }] : []),
          { id: "ultracode", value: false },
        ]),
        catalog,
      );
      expect(off.effort).toBe(compiled.effort);
      expect(off.queryIdentity).not.toBe(compiled.queryIdentity);
    },
  );

  it("allows a native custom model to use Ultracode with its chosen high effort", () => {
    const catalog = scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
      {
        slug: "custom-high-only",
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Reasoning",
              type: "select",
              options: [{ id: "high", label: "High", isDefault: true }],
            },
          ],
        },
      },
    ]);
    const selected = selection("custom-high-only", [
      { id: "effort", value: "high" },
      { id: "ultracode", value: true },
    ]);
    const options = makeClaudeQueryOptions({
      modelSelection: selected,
      modelCatalog: catalog,
      nativeThreadId: "custom-ultracode",
      resume: false,
      cwd: null,
    });
    expect(options.settings).toMatchObject({ ultracode: true, enableWorkflows: true });
    expect(options.effort).toBe("high");
    expect(options.env?.CLAUDE_CODE_EXTRA_BODY).toBeUndefined();
  });

  it("passes service-tier selections through extra body without turning on Claude native Fast", () => {
    const catalog = resolveClaudeModelServiceCatalog([
      {
        slug: "speed-model",
        capabilities: {
          optionDescriptors: [
            {
              id: "serviceTier",
              label: "Service Tier",
              type: "select",
              options: [
                { id: "default", label: "Standard", isDefault: true },
                { id: "priority", label: "Fast" },
              ],
            },
          ],
        },
      },
    ]);
    const normal = compileClaudeModelSelection(selection("speed-model", []), catalog);
    const fast = compileClaudeModelSelection(
      selection("speed-model", [{ id: "serviceTier", value: "priority" }]),
      catalog,
    );
    expect(fast.requestServiceTier).toBe("priority");
    expect(fast.settings.fastMode).toBeUndefined();
    expect(normal.requestServiceTier).toBe("default");
    expect(fast.queryIdentity).not.toBe(normal.queryIdentity);
    expect(
      JSON.parse(
        claudeRequestEffortEnvironment(
          "ultra",
          '{"metadata":{"source":"kept"}}',
          fast.requestServiceTier,
        )!.CLAUDE_CODE_EXTRA_BODY!,
      ),
    ).toEqual({
      metadata: { source: "kept" },
      output_config: { effort: "ultra" },
      service_tier: "priority",
    });
    expect(
      JSON.parse(
        claudeRequestEffortEnvironment(undefined, undefined, "priority")!.CLAUDE_CODE_EXTRA_BODY!,
      ),
    ).toEqual({ service_tier: "priority" });
  });
  it("includes custom context limits in query identity", () => {
    const customSelection = selection("custom-context", []);
    const compile = (contextWindow: number) =>
      compileClaudeModelSelection(
        customSelection,
        scopeClaudeModelCatalog(BUNDLED_CLAUDE_MODEL_CATALOG, [
          { slug: "custom-context", capabilities: { contextWindow } },
        ]),
      );
    expect(compile(262144).contextWindowTokens).toBe(262144);
    expect(compile(262144).queryIdentity).not.toBe(compile(1048576).queryIdentity);
    expect(compileClaudeModelSelection(customSelection).contextWindowTokens).toBeUndefined();
  });
  it("compiles context, effort, and settings together", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-opus-4-6", [
          { id: "contextWindow", value: "1m" },
          { id: "effort", value: "max" },
          { id: "fastMode", value: true },
        ]),
      ),
    ).toMatchObject({
      apiModelId: "claude-opus-4-6[1m]",
      effort: "max",
      settings: { fastMode: true },
    });
  });

  it("uses the model default SDK effort alongside prompt-injected effort", () => {
    expect(
      compileClaudeModelSelection(
        selection("claude-sonnet-4-6", [{ id: "effort", value: "ultrathink" }]),
      ),
    ).toMatchObject({ effort: "high", promptEffort: "ultrathink" });
  });

  it("ignores thinking for catalog models without a thinking option", () => {
    expect(
      compileClaudeModelSelection(selection("claude-opus-5-5", [{ id: "thinking", value: false }]))
        .settings,
    ).not.toHaveProperty("alwaysThinkingEnabled");
  });

  it.each(["gateway-route", "gateway-route[1m]"])(
    "keeps explicit effort and thinking for %s outside the local catalog",
    (model) => {
      for (const thinking of [true, false]) {
        expect(
          compileClaudeModelSelection(
            selection(model, [
              { id: "effort", value: "max" },
              { id: "thinking", value: thinking },
            ]),
          ),
        ).toMatchObject({
          apiModelId: model,
          effort: "max",
          settings: { alwaysThinkingEnabled: thinking },
        });
      }
      const unconfigured = compileClaudeModelSelection(selection(model, []));
      expect(unconfigured.effort).toBeUndefined();
      expect(unconfigured.settings).toEqual({});
    },
  );

  it.each(["high", "ultra", "vendor-effort"])(
    "routes a bound service's %s effort through the request body rather than Claude CLI flags",
    (effort) => {
      const catalog = resolveClaudeModelServiceCatalog([
        {
          slug: "gpt-service-model",
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                options: ["high", "ultra", "vendor-effort"].map((id) => ({
                  id,
                  label: id,
                  isDefault: id === "ultra",
                })),
              },
            ],
          },
        },
      ]);
      expect(
        compileClaudeModelSelection(
          selection("gpt-service-model", [{ id: "effort", value: effort }]),
          catalog,
        ),
      ).toMatchObject({ effort, nativeEffort: undefined, requestEffort: effort });
      expect(
        compileClaudeModelSelection(selection("gpt-service-model", []), catalog),
      ).toMatchObject({ effort: "ultra", nativeEffort: undefined, requestEffort: "ultra" });
    },
  );

  it("merges service effort without discarding unrelated extra-body settings", () => {
    const environment = claudeRequestEffortEnvironment(
      "ultra",
      JSON.stringify({
        metadata: { source: "kept" },
        output_config: { format: { type: "json" }, effort: "high" },
      }),
    );
    expect(JSON.parse(environment!.CLAUDE_CODE_EXTRA_BODY!)).toEqual({
      metadata: { source: "kept" },
      output_config: { format: { type: "json" }, effort: "ultra" },
    });
    expect(claudeRequestEffortEnvironment(undefined, "invalid")).toBeUndefined();
    expect(
      JSON.parse(claudeRequestEffortEnvironment("ultra", "invalid")!.CLAUDE_CODE_EXTRA_BODY!),
    ).toEqual({ output_config: { effort: "ultra" } });
  });
});
