import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, SecretProviderId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  mergeProviderInstanceEnvironment,
  scopeModelServiceEnvironment,
} from "./instanceEnvironment.ts";

describe("mergeProviderInstanceEnvironment", () => {
  it("isolates model service credentials across sessions without changing unrelated keys", () => {
    const environment = {
      COX_MODEL_SERVICE_KEY: "local-key",
      COX_CODEX_API_KEY: "local-key",
      OPENAI_API_KEY: "independent-key",
      ANTHROPIC_API_KEY: "local-key",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: {
          cox: {
            options: { apiKey: "local-key", baseURL: "http://127.0.0.1/api/model-gateway/v1" },
          },
        },
      }),
    };
    const a = scopeModelServiceEnvironment(environment, ProviderSessionId.make("session-a"));
    const b = scopeModelServiceEnvironment(environment, ProviderSessionId.make("session-b"));
    expect(a.COX_CODEX_API_KEY).toBe("local-key.session-a");
    expect(b.COX_CODEX_API_KEY).toBe("local-key.session-b");
    expect(a.OPENAI_API_KEY).toBe("independent-key");
    expect(a.ANTHROPIC_API_KEY).toBe("local-key.session-a");
    expect(JSON.parse(a.OPENCODE_CONFIG_CONTENT!).provider.cox.options.apiKey).toBe(
      "local-key.session-a",
    );
    expect(environment.COX_MODEL_SERVICE_KEY).toBe("local-key");
    expect(
      scopeModelServiceEnvironment(
        { OPENAI_API_KEY: "direct" },
        ProviderSessionId.make("session-a"),
      ),
    ).toEqual({ OPENAI_API_KEY: "direct" });
  });
  it.effect.each([
    { value: "~/.account", tail: ".account" },
    { value: "~\\.account\\work", tail: ".account\\work" },
  ])("expands configured provider homes set to $value", ({ value, tail }) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const baseEnv = {
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      };
      const environment = yield* mergeProviderInstanceEnvironment(
        [
          { name: "CODEX_HOME", value, sensitive: false },
          { name: "CLAUDE_CONFIG_DIR", value, sensitive: false },
          { name: "CUSTOM_VALUE", value, sensitive: false },
        ],
        baseEnv,
      );

      expect(environment).toEqual({
        CODEX_HOME: path.join("/home/ada", tail),
        CLAUDE_CONFIG_DIR: path.join("/home/ada", tail),
        CUSTOM_VALUE: value,
      });
      expect(baseEnv).toEqual({
        CODEX_HOME: "~/.inherited-codex",
        CLAUDE_CONFIG_DIR: "~/.inherited-claude",
      });
    }).pipe(
      Effect.provideService(HostProcess.HomeDirectory, "/home/ada"),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves inherited provider homes unchanged", () =>
    Effect.gen(function* () {
      const baseEnv = { CODEX_HOME: "~/.codex", CLAUDE_CONFIG_DIR: "~\\.claude" };

      expect(
        yield* mergeProviderInstanceEnvironment(
          [{ name: "CUSTOM_VALUE", value: "~/.custom", sensitive: false }],
          baseEnv,
        ),
      ).toEqual({ ...baseEnv, CUSTOM_VALUE: "~/.custom" });
    }),
  );

  it.effect("overrides inherited environment values and preserves empty strings", () =>
    Effect.gen(function* () {
      expect(
        yield* mergeProviderInstanceEnvironment(
          [
            { name: "OPENROUTER_API_KEY", value: "sk-or-test", sensitive: true },
            { name: "ANTHROPIC_API_KEY", value: "", sensitive: false },
            {
              name: "OPENAI_API_KEY",
              value: {
                provider: SecretProviderId.make("personal"),
                reference: "op://Private/OpenAI/credential",
              },
              sensitive: true,
            },
          ],
          { ANTHROPIC_API_KEY: "inherited", OPENAI_API_KEY: "inherited", PATH: "/bin" },
        ),
      ).toMatchObject({
        OPENROUTER_API_KEY: "sk-or-test",
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "inherited",
        PATH: "/bin",
      });
    }),
  );
});
