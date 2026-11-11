import {
  ProviderDriverKind,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderModelCapabilities } from "./providerModels";

const PROVIDER = ProviderDriverKind.make("claudeAgent");

function capabilities(id: string): ModelCapabilities {
  return {
    optionDescriptors: [{ id, label: id, type: "boolean" }],
  };
}

function model(input: {
  slug: string;
  capabilities: ModelCapabilities;
  aliases?: ReadonlyArray<string>;
  isCustom?: boolean;
}): ServerProviderModel {
  return {
    slug: input.slug,
    name: input.slug,
    ...(input.aliases ? { aliases: [...input.aliases] } : {}),
    isCustom: input.isCustom ?? false,
    capabilities: input.capabilities,
  };
}

describe("getProviderModelCapabilities", () => {
  it("resolves model-declared aliases", () => {
    const aliasCapabilities = capabilities("aliased-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["Legacy-Synthetic-Model"],
        capabilities: aliasCapabilities,
      }),
    ];

    expect(getProviderModelCapabilities(models, "legacy-synthetic-model", PROVIDER)).toEqual(
      aliasCapabilities,
    );
  });

  it("keeps native OpenCode agents selectable without legacy plan mode", () => {
    const opencode = ProviderDriverKind.make("opencode");
    const agentCapabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id: "agent",
          label: "Agent",
          type: "select",
          options: [
            { id: "build", label: "Build", isDefault: true },
            { id: "plan", label: "Plan" },
          ],
          currentValue: "build",
        },
      ],
    };
    expect(
      getProviderModelCapabilities(
        [model({ slug: "opencode/model", capabilities: agentCapabilities })],
        "opencode/model",
        opencode,
        false,
      ),
    ).toEqual(agentCapabilities);
  });

  it("hides the legacy interaction mode without filtering native agent choices", () => {
    const models = [
      model({
        slug: "test-model",
        capabilities: {
          optionDescriptors: [
            { id: "interactionMode", label: "Mode", type: "boolean", currentValue: true },
          ],
        },
      }),
    ];
    expect(
      getProviderModelCapabilities(
        models,
        "test-model",
        ProviderDriverKind.make("opencode"),
        false,
      ),
    ).toEqual({
      optionDescriptors: [],
    });
  });

  it("prefers an exact custom slug over a built-in model alias", () => {
    const customCapabilities = capabilities("custom-option");
    const models = [
      model({
        slug: "synthetic-model",
        aliases: ["custom-model"],
        capabilities: capabilities("built-in-option"),
      }),
      model({ slug: "custom-model", capabilities: customCapabilities, isCustom: true }),
    ];

    expect(getProviderModelCapabilities(models, " custom-model ", PROVIDER)).toEqual(
      customCapabilities,
    );
  });
});
