import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import { buildInitialOmpProviderSnapshot, parseOmpDiscoveredModels } from "./status.ts";
import { OmpSettings } from "../settings.ts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

const decodeSettings = Schema.decodeSync(OmpSettings);
const settings = (patch: Partial<OmpSettings> = {}): OmpSettings => ({
  ...decodeSettings({}),
  ...patch,
});

describe("parseOmpDiscoveredModels", () => {
  it("maps the native inventory with live thinking levels for the active model", () => {
    const result = parseOmpDiscoveredModels(
      {
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4",
            name: "Claude Sonnet 4",
            reasoning: true,
            contextWindow: 200_000,
          },
          { provider: "openai", id: "gpt-5" },
        ],
      },
      {
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      },
      ["off", "low", "high"],
    );
    expect(Result.isSuccess(result)).toBe(true);
    const models = Result.isSuccess(result) ? result.success : [];
    expect(models.map((model) => model.slug)).toEqual([
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
    ]);
    const thinking = models[0]?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.id === "thinking" && descriptor.type === "select",
    );
    expect(
      thinking?.type === "select" ? thinking.options.map((option) => option.id) : undefined,
    ).toEqual(["off", "low", "high"]);
    const defaulted =
      thinking?.type === "select" ? thinking.options.find((option) => option.isDefault) : undefined;
    expect(defaulted?.id).toBe("high");
    expect(models[1]?.capabilities?.optionDescriptors).toEqual([]);
  });

  it("falls back to model metadata inference without live levels", () => {
    const result = parseOmpDiscoveredModels(
      { models: [{ provider: "anthropic", id: "claude-sonnet-4", reasoning: true }] },
      {},
    );
    expect(Result.isSuccess(result)).toBe(true);
    const thinking = Result.isSuccess(result)
      ? result.success[0]?.capabilities?.optionDescriptors?.find(
          (descriptor) => descriptor.id === "thinking" && descriptor.type === "select",
        )
      : undefined;
    expect(
      thinking?.type === "select" ? thinking.options.map((option) => option.id) : undefined,
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("rejects a malformed or incomplete inventory instead of fabricating models", () => {
    expect(Result.isFailure(parseOmpDiscoveredModels({ models: "nope" }, {}))).toBe(true);
    expect(
      Result.isFailure(parseOmpDiscoveredModels({ models: [{ provider: "", id: "broken" }] }, {})),
    ).toBe(true);
  });
});

describe("buildInitialOmpProviderSnapshot", () => {
  it("reports a disabled provider without probing", async () => {
    const snapshot = await Effect.runPromise(buildInitialOmpProviderSnapshot(settings()));
    if (snapshot === null) throw new Error("disabled snapshot must not be null");
    expect(snapshot).toMatchObject({
      displayName: "Oh My Pi",
      enabled: false,
      installed: false,
      status: "disabled",
      message: "Oh My Pi is disabled in Cox settings.",
    });
    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
  });

  it("announces a pending check for enabled providers", async () => {
    const snapshot = await Effect.runPromise(
      buildInitialOmpProviderSnapshot(settings({ enabled: true })),
    );
    if (snapshot === null) throw new Error("enabled snapshot must not be null");
    expect(snapshot).toMatchObject({
      displayName: "Oh My Pi",
      enabled: true,
      installed: true,
      status: "warning",
    });
  });
});
