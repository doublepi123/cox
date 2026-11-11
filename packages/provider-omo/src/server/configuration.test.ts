import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OmoSettings } from "../settings.ts";
import { omoEnvironment, omoTaskConfiguration } from "./configuration.ts";

const settings = Schema.decodeSync(OmoSettings);

describe("OMO model configuration", () => {
  it("keeps mutable inheritance arrays before an independent main model is selected", () => {
    const native = omoTaskConfiguration(settings({}), "/tasks");
    expect(native.agents.explore).toEqual({ models: [], models_distribution: "round_robin" });
    expect(native.categories.quick).toEqual({ models: [], models_distribution: "round_robin" });
  });

  it("preserves managed upstream IDs that already start with the Cox provider name", () => {
    const native = omoTaskConfiguration(
      settings({
        modelServiceManaged: true,
        provider: "cox",
        model: "cox/model",
        customModels: [{ slug: "cox/cox/model" }],
      }),
      "/tasks",
    );
    expect(native.agents.explore?.models).toEqual(["cox/cox/model"]);
  });
  it("restricts native role assignments to exact models in the managed binding", () => {
    const config = settings({
      modelServiceManaged: true,
      provider: "cox",
      model: "Vendor/Exact",
      customModels: [{ slug: "cox/Vendor/Exact" }, { slug: "cox/other" }],
      agentModels: { explore: "cox/other" },
    });
    const native = omoTaskConfiguration(config, "/isolated/tasks");
    expect(native.agents.explore).toEqual({
      models: ["cox/other"],
      models_distribution: "round_robin",
    });
    expect(native.categories.quick).toEqual({
      models: ["cox/Vendor/Exact"],
      models_distribution: "round_robin",
    });
    expect(native.task.state_dir).toEqual("/isolated/tasks");
    expect(() =>
      omoTaskConfiguration(
        { ...config, agentModels: { explore: "anthropic/foreign" } },
        "/isolated/tasks",
      ),
    ).toThrow("not available");
  });

  it("does not double-prefix a model selector and rejects invalid roles", () => {
    const config = settings({ provider: "cox", model: "cox/model" });
    expect(omoTaskConfiguration(config, "/tasks").categories.quick).toMatchObject({
      models: ["cox/model"],
    });
    expect(() => settings({ agentModels: { "../outside": "cox/model" } })).toThrow();
    expect(() => settings({ agentModels: { constructor: "cox/model" } })).toThrow();
    expect(() => settings({ agentModels: { "1invalid": "cox/model" } })).toThrow();
    expect(() =>
      omoTaskConfiguration({ ...config, agentModels: { "1invalid": "cox/model" } }, "/tasks"),
    ).toThrow("start with a letter");
  });

  it("isolates engine state and keeps human client capabilities off descendants", () => {
    const env = omoEnvironment(settings({ agentDir: "/isolated/agent" }), {
      SENPI_RPC_CLIENT_CAPABILITIES: "interactive_user",
      OMO_RPC_CLIENT_CAPABILITIES: "interactive_user",
    });
    expect(env).toMatchObject({
      PI_CODING_AGENT_DIR: "/isolated/agent",
      SENPI_CODING_AGENT_DIR: "/isolated/agent",
      OMO_CODING_AGENT_DIR: "/isolated/agent",
    });
    expect(env.SENPI_RPC_CLIENT_CAPABILITIES).toBeUndefined();
    expect(env.OMO_RPC_CLIENT_CAPABILITIES).toBeUndefined();
  });
  it("keeps ambient model credentials out of a managed runtime", () => {
    const env = omoEnvironment(settings({ modelServiceManaged: true }), {
      ANTHROPIC_API_KEY: "ambient",
      CLAUDE_CODE_OAUTH_TOKEN_2: "ambient",
      HF_TOKEN: "ambient",
      COX_MODEL_SERVICE_KEY: "scoped",
      PATH: "/bin",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN_2).toBeUndefined();
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.COX_MODEL_SERVICE_KEY).toEqual("scoped");
    expect(env.PATH).toEqual("/bin");
  });
});
