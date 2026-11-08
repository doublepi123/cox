import type { ModelSelection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  getProviderOptionCurrentValue,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly nativeEffort: string | undefined;
  readonly requestEffort: string | undefined;
  readonly requestServiceTier: string | undefined;
  readonly promptEffort: string | undefined;
  readonly contextWindowTokens: number | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly queryIdentity: string;
}

export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: selection.options,
  });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  const resolvedEffort = resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const effort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  const ultracode = descriptors.find((descriptor) => descriptor.id === "ultracode")?.currentValue;
  const nativeEffort = catalog.source === "model-service" && !ultracode ? undefined : effort;
  const requestEffort = catalog.source === "model-service" ? effort : undefined;
  const tier = getProviderOptionCurrentValue(
    getProviderOptionDescriptors({
      caps: capabilities,
      selections: selection.options,
    }).find((descriptor) => descriptor.id === "serviceTier" && descriptor.type === "select"),
  );
  const requestServiceTier =
    catalog.source === "model-service" && typeof tier === "string" ? tier : undefined;
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(typeof ultracode === "boolean"
      ? { ultracode, ...(ultracode ? { enableWorkflows: true } : {}) }
      : {}),
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const contextWindowTokens = capabilities.contextWindow;
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  return {
    apiModelId,
    effort,
    nativeEffort,
    requestEffort,
    requestServiceTier,
    promptEffort,
    contextWindowTokens,
    settings,
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      requestEffort: requestEffort ?? null,
      requestServiceTier: requestServiceTier ?? null,
      settings,
      contextWindowTokens,
    }),
  };
}

const decodeExtraBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

export function claudeRequestEffortEnvironment(
  effort: string | undefined,
  extraBody?: string,
  serviceTier?: string,
): Record<string, string> | undefined {
  if (effort === undefined && serviceTier === undefined) return undefined;
  const body: Readonly<Record<string, unknown>> = Option.getOrElse(
    decodeExtraBody(extraBody ?? "{}"),
    () => ({}),
  );
  const config = body.output_config;
  return {
    CLAUDE_CODE_EXTRA_BODY: JSON.stringify({
      ...body,
      ...(effort === undefined
        ? {}
        : {
            output_config: {
              ...(typeof config === "object" && config !== null && !Array.isArray(config)
                ? config
                : {}),
              effort,
            },
          }),
      ...(serviceTier === undefined ? {} : { service_tier: serviceTier }),
    }),
  };
}
