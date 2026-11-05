import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { secretSettingsFields } from "@t3tools/contracts";
import { PiSettings } from "../settings.ts";
import { configuredPiLaunchArgs, piEnvironment } from "./configuration.ts";

const decodeSettings = Schema.decodeSync(PiSettings);
const settings = (patch: Partial<PiSettings> = {}): PiSettings => ({
  ...decodeSettings({}),
  ...patch,
});

describe("Pi configuration", () => {
  it("trusts projects by default for new and existing empty launch settings", () => {
    expect(configuredPiLaunchArgs(settings())).toEqual({ ok: true, args: ["--approve"] });
    expect(configuredPiLaunchArgs(settings({ launchArgs: '--skill "extra skill"' }))).toEqual({
      ok: true,
      args: ["--approve", "--skill", "extra skill"],
    });
  });

  it.each(["--approve", "-a", "--no-approve", "-na"])(
    "preserves an explicit project trust choice %s",
    (launchArgs) => {
      expect(configuredPiLaunchArgs(settings({ launchArgs }))).toEqual({
        ok: true,
        args: [launchArgs],
      });
    },
  );

  it("preserves native Pi credentials and arguments when setup fields are empty", () => {
    const config = settings({ launchArgs: '--approve --skill "extra skill"' });
    const env = {
      PATH: "/bin",
      ANTHROPIC_API_KEY: "existing-test-key",
      PI_CODING_AGENT_DIR: "/pi-existing",
    };
    expect(piEnvironment(config, env)).toEqual(env);
    expect(configuredPiLaunchArgs(config)).toEqual({
      ok: true,
      args: ["--approve", "--skill", "extra skill"],
    });
  });

  it.each([
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["google", "GEMINI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
  ])(
    "passes %s credentials through its environment without putting secrets in arguments",
    (provider, variable) => {
      const config = settings({
        provider,
        model: "model with spaces",
        apiKey: "test-pi-key",
        agentDir: "/isolated/pi",
      });
      const env = { [variable]: "old-test-key" };
      expect(piEnvironment(config, env)).toEqual({
        [variable]: "test-pi-key",
        PI_CODING_AGENT_DIR: "/isolated/pi",
      });
      expect(env[variable]).toBe("old-test-key");
      expect(configuredPiLaunchArgs(config)).toEqual({
        ok: true,
        args: ["--approve", "--provider", provider, "--model", "model with spaces"],
      });
    },
  );

  it("accepts a qualified model and keeps advanced arguments while explicit model fields take priority", () => {
    const config = settings({
      model: "openai/example",
      apiKey: "test-pi-key",
      launchArgs: "--model previous --approve",
    });
    expect(piEnvironment(config, {}).OPENAI_API_KEY).toBe("test-pi-key");
    expect(configuredPiLaunchArgs(config)).toEqual({
      ok: true,
      args: ["--model", "previous", "--approve", "--model", "openai/example"],
    });
  });

  it("rejects an unbound API key without revealing it and preserves reserved argument checks", () => {
    const result = configuredPiLaunchArgs(settings({ apiKey: "test-pi-key" }));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("test-pi-key");
    expect(configuredPiLaunchArgs(settings({ launchArgs: "--mode interactive" })).ok).toBe(false);
  });

  it("marks the API key for separate secret storage and keeps legacy settings valid", () => {
    expect(secretSettingsFields(PiSettings)).toEqual(["apiKey"]);
    expect(decodeSettings({ enabled: true, launchArgs: "--approve" })).toMatchObject({
      enabled: true,
      launchArgs: "--approve",
    });
  });
});
