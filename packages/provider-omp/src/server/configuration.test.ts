import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import {
  configuredOmpLaunchArgs,
  ompApiKeyVariable,
  ompEnvironment,
  prepareOmpConfiguration,
  resolveOmpLaunchArgs,
} from "./configuration.ts";
import { OmpSettings } from "../settings.ts";

const decodeSettings = Schema.decodeSync(OmpSettings);
const settings = (patch: Partial<OmpSettings> = {}): OmpSettings => ({
  ...decodeSettings({}),
  ...patch,
});

describe("Oh My Pi launch arguments", () => {
  it("accepts omp flags without injecting Pi resource flags", () => {
    expect(
      resolveOmpLaunchArgs('--no-skills --append-system-prompt "stay sharp" --tools read'),
    ).toEqual({
      ok: true,
      args: ["--no-skills", "--append-system-prompt", "stay sharp", "--tools", "read"],
    });
    expect(configuredOmpLaunchArgs(settings())).toEqual({ ok: true, args: [] });
  });

  it.each([
    "--mode",
    "--session",
    "--resume",
    "--approval-mode",
    "--yolo",
    "--auto-approve",
    "--fork",
    "--print",
    "--cwd",
    "--no-ui",
  ])("rejects Cox-controlled omp flag %s", (flag) => {
    const resolution = resolveOmpLaunchArgs(`${flag} value`);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.message).toContain(flag);
  });

  it.each([
    "--approve",
    "--no-approve",
    "--permission-preset",
    "--no-themes",
    "--no-prompt-templates",
  ])("rejects Pi-only flag %s with Oh My Pi guidance", (flag) => {
    const resolution = resolveOmpLaunchArgs(flag === "--permission-preset" ? `${flag} ask` : flag);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.message).toContain("does not support");
      expect(resolution.message).toContain(flag);
    }
  });

  it("rejects positional prompts, bare short flags and missing values", () => {
    expect(resolveOmpLaunchArgs("just start")).toEqual({
      ok: false,
      message: "Oh My Pi launch arguments cannot include positional prompt 'just'.",
    });
    expect(resolveOmpLaunchArgs("-x")).toEqual({
      ok: false,
      message: "Oh My Pi launch argument '-x' is not supported by Cox.",
    });
    expect(resolveOmpLaunchArgs("--thinking")).toEqual({
      ok: false,
      message: "Oh My Pi launch argument '--thinking' requires a value.",
    });
  });

  it("accepts the native valueless advisor flag without a positional prompt", () => {
    expect(resolveOmpLaunchArgs("--advisor")).toEqual({ ok: true, args: ["--advisor"] });
    expect(resolveOmpLaunchArgs("--advisor stray-token")).toEqual({
      ok: false,
      message: "Oh My Pi launch arguments cannot include positional prompt 'stray-token'.",
    });
    expect(resolveOmpLaunchArgs("--advisor --no-skills")).toEqual({
      ok: true,
      args: ["--advisor", "--no-skills"],
    });
  });

  it("requires a model with an explicit provider and appends the selected model", () => {
    expect(resolveOmpLaunchArgs("--provider anthropic")).toEqual({
      ok: false,
      message: "Oh My Pi launch argument '--provider' requires '--model'.",
    });
    expect(configuredOmpLaunchArgs(settings({ provider: "openrouter", model: "model x" }))).toEqual(
      {
        ok: true,
        args: ["--provider", "openrouter", "--model", "model x"],
      },
    );
  });

  it("keeps unknown extension flags with one optional value token", () => {
    expect(resolveOmpLaunchArgs("--custom-flag value --no-skills")).toEqual({
      ok: true,
      args: ["--custom-flag", "value", "--no-skills"],
    });
  });
});

describe("Oh My Pi environment", () => {
  it.each([
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
    ["google", "GEMINI_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["kimi-code", "KIMI_API_KEY"],
    ["moonshot", "KIMI_API_KEY"],
  ])("scopes %s credentials and the agent directory", (provider, variable) => {
    const config = settings({ provider, apiKey: "test-omp-key", agentDir: "/isolated/omp" });
    expect(ompEnvironment(config, { PATH: "/bin", [variable]: "old" })).toEqual({
      PATH: "/bin",
      PI_CODING_AGENT_DIR: "/isolated/omp",
      [variable]: "test-omp-key",
    });
    expect(ompApiKeyVariable(settings({ model: "openrouter/x" }))).toBe("OPENROUTER_API_KEY");
  });

  it("rejects an API key for an unknown provider", () => {
    const resolution = configuredOmpLaunchArgs(
      settings({ provider: "custom-gateway", apiKey: "test-omp-key" }),
    );
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) expect(resolution.message).toContain("models.yml");
  });
});

effectIt.layer(NodeServices.layer)("prepareOmpConfiguration", (it) => {
  it.effect("scopes a per-instance agent directory and sessions under it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = (yield* fs.makeTempDirectoryScoped().pipe(Effect.scoped)).replace(/\\/g, "/");
      const prepared = yield* prepareOmpConfiguration(
        settings(),
        { PATH: "/bin" },
        baseDir,
        "instance-1",
      );
      expect(prepared.settings.agentDir).toBe(`${baseDir}/providers/omp/instance-1/agent`);
      expect(prepared.settings.sessionDir).toBe(
        `${baseDir}/providers/omp/instance-1/agent/sessions`,
      );
      expect(prepared.environment.PI_CODING_AGENT_DIR).toBe(
        `${baseDir}/providers/omp/instance-1/agent`,
      );
      expect(yield* fs.exists(prepared.settings.agentDir!)).toBe(true);
    }),
  );

  it.effect("keeps an explicitly configured agent directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = (yield* fs.makeTempDirectoryScoped().pipe(Effect.scoped)).replace(/\\/g, "/");
      const agentDir = `${baseDir}/custom-agent`;
      const prepared = yield* prepareOmpConfiguration(
        settings({ agentDir }),
        { PATH: "/bin" },
        baseDir,
        "instance-1",
      );
      expect(prepared.settings.agentDir).toBe(agentDir);
      expect(prepared.environment.PI_CODING_AGENT_DIR).toBe(agentDir);
      expect(prepared.settings.sessionDir).toBe(`${agentDir}/sessions`);
      expect(yield* fs.exists(agentDir)).toBe(true);
    }),
  );
});
