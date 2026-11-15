import type { OmpSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";

export const OMP_VERSION = "18.20.2";
export const OMP_BUN_VERSION = "1.4.4";

const API_KEY_VARIABLES: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "kimi-coding": "KIMI_API_KEY",
  huggingface: "HF_TOKEN",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  minimax: "MINIMAX_API_KEY",
};

function modelProvider(settings: OmpSettings): string | undefined {
  return settings.provider?.trim() || settings.model?.split("/")[0];
}

export function ompApiKeyVariable(settings: OmpSettings): string | undefined {
  return API_KEY_VARIABLES[modelProvider(settings) ?? ""];
}

export function ompEnvironment(
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const variable = ompApiKeyVariable(settings);
  return {
    ...environment,
    ...(settings.agentDir?.trim() ? { PI_CODING_AGENT_DIR: settings.agentDir.trim() } : {}),
    ...(settings.apiKey?.trim() && variable ? { [variable]: settings.apiKey.trim() } : {}),
  };
}

const RESERVED_OMP_LAUNCH_ARGUMENTS = new Set([
  "--approval-mode",
  "--auto-approve",
  "--continue",
  "-c",
  "--cwd",
  "--export",
  "--fork",
  "--help",
  "-h",
  "--mode",
  "--no-session",
  "--no-tools",
  "--no-ui",
  "--print",
  "--print-thoughts",
  "--restore",
  "--resume",
  "-r",
  "--session",
  "--session-id",
  "--version",
  "-v",
  "--yolo",
]);

const OMP_ARGUMENTS_WITH_VALUES = new Set([
  "--add-dir",
  "--advisor",
  "--api-key",
  "--append-system-prompt",
  "--approval-mode",
  "--config",
  "--cwd",
  "--extension",
  "-e",
  "--fork",
  "--goal",
  "--hook",
  "--max-cost",
  "--max-fps",
  "--max-time",
  "--mode",
  "--model",
  "--models",
  "--motion",
  "--plan",
  "--plan-yolo-into",
  "--plugin-dir",
  "--prewalk-into",
  "--prompt-cache-key",
  "--provider",
  "--provider-session-id",
  "--service-tier",
  "--session-dir",
  "--skills",
  "--smol",
  "--slow",
  "--spinner-interval",
  "--system-prompt",
  "--system-prompt-template",
  "--thinking",
  "--tools",
  "--trusted-extension",
  "--warn-cost",
]);

const OMP_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--allow-home",
  "--auto-approve",
  "--continue",
  "--external-thinking",
  "--from-claude",
  "--from-codex",
  "--help",
  "--hide-thinking",
  "--no-context-files",
  "--no-extensions",
  "--no-judge",
  "--no-lsp",
  "--no-prewalk",
  "--no-pty",
  "--no-rules",
  "--no-session",
  "--no-skills",
  "--no-spotlight",
  "--no-title",
  "--no-tools",
  "--no-ui",
  "--offline",
  "--plan-yolo",
  "--prewalk",
  "--print",
  "--print-thoughts",
  "--version",
  "--wait-async",
  "--yolo",
]);

const PI_ONLY_ARGUMENTS_WITHOUT_VALUES = new Set([
  "--approve",
  "-a",
  "--no-approve",
  "-na",
  "--no-builtin-tools",
  "-nbt",
  "--no-prompt-templates",
  "-np",
  "--no-themes",
  "-nt",
]);

const PI_ONLY_ARGUMENTS_WITH_VALUES = new Set(["--permission-preset"]);

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

function reservedOmpArgument(arg: string): string | undefined {
  for (const reserved of RESERVED_OMP_LAUNCH_ARGUMENTS) {
    if (arg === reserved || (reserved.startsWith("--") && arg.startsWith(`${reserved}=`))) {
      return reserved;
    }
  }
  return undefined;
}

function piOnlyArgument(arg: string): string | undefined {
  if (PI_ONLY_ARGUMENTS_WITHOUT_VALUES.has(arg)) return arg;
  for (const reserved of PI_ONLY_ARGUMENTS_WITH_VALUES) {
    if (arg === reserved || arg.startsWith(`${reserved}=`)) return reserved;
  }
  return undefined;
}

function normalizeOmpEqualsArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  return args.flatMap((arg) => {
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex <= 0) return [arg];
    const option = arg.slice(0, equalsIndex);
    return OMP_ARGUMENTS_WITH_VALUES.has(option) ? [option, arg.slice(equalsIndex + 1)] : [arg];
  });
}

export function resolveOmpLaunchArgs(launchArgs: string): OmpLaunchArgsResolution {
  const args = normalizeOmpEqualsArguments(tokenizeCliArgs(launchArgs));
  let hasProvider = false;
  let hasModel = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const reserved = reservedOmpArgument(arg);
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `Oh My Pi launch argument '${reserved}' is controlled by Cox and cannot be overridden.`,
      };
    }
    const piOnly = piOnlyArgument(arg);
    if (piOnly !== undefined) {
      return {
        ok: false,
        message: `Oh My Pi does not support Pi launch argument '${piOnly}'. Remove it, or configure the equivalent in Oh My Pi settings.`,
      };
    }
    if (arg === "--") {
      return {
        ok: false,
        message: "Oh My Pi launch arguments cannot include positional prompts.",
      };
    }
    if (OMP_ARGUMENTS_WITH_VALUES.has(arg)) {
      const value = args[index + 1];
      if (value === undefined) {
        return { ok: false, message: `Oh My Pi launch argument '${arg}' requires a value.` };
      }
      if (arg === "--provider") hasProvider = true;
      if (arg === "--model") hasModel = true;
      index += 1;
      continue;
    }
    if (OMP_ARGUMENTS_WITHOUT_VALUES.has(arg) || (arg.startsWith("--") && arg.includes("="))) {
      continue;
    }
    if (arg.startsWith("--")) {
      if (
        args[index + 1] !== undefined &&
        !args[index + 1]!.startsWith("-") &&
        !args[index + 1]!.startsWith("@")
      ) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        ok: false,
        message: `Oh My Pi launch argument '${arg}' is not supported by Cox.`,
      };
    }
    return {
      ok: false,
      message: `Oh My Pi launch arguments cannot include positional prompt '${arg}'.`,
    };
  }
  if (hasProvider && !hasModel) {
    return {
      ok: false,
      message: "Oh My Pi launch argument '--provider' requires '--model'.",
    };
  }
  return { ok: true, args };
}

export function configuredOmpLaunchArgs(settings: OmpSettings): OmpLaunchArgsResolution {
  const resolved = resolveOmpLaunchArgs(settings.launchArgs);
  if (!resolved.ok) return resolved;
  if (settings.apiKey?.trim() && !ompApiKeyVariable(settings))
    return {
      ok: false,
      message:
        "Select a supported Oh My Pi model provider before adding an API key. For custom providers, configure credentials in Oh My Pi's models.yml or provider environment.",
    };
  return {
    ok: true,
    args: [
      ...resolved.args,
      ...(settings.model?.trim()
        ? [
            ...(settings.provider?.trim() ? ["--provider", settings.provider.trim()] : []),
            "--model",
            settings.model.trim(),
          ]
        : []),
    ],
  };
}

export function ompInstanceDirectory(baseDir: string, instanceId: string, path: Path.Path): string {
  return path.join(
    baseDir,
    "providers",
    "omp",
    instanceId === "." || instanceId === ".."
      ? instanceId.replaceAll(".", "%2E")
      : encodeURIComponent(instanceId),
  );
}

export const prepareOmpConfiguration = Effect.fn("prepareOmpConfiguration")(function* (
  settings: OmpSettings,
  environment: NodeJS.ProcessEnv,
  baseDir: string,
  instanceId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* Effect.try(() => {
    if (!instanceId.trim()) throw new Error("Oh My Pi requires a Cox instance ID.");
  });
  const instanceDirectory = ompInstanceDirectory(baseDir, instanceId, path);
  const agentDir = settings.agentDir?.trim() || path.join(instanceDirectory, "agent");
  const configured: OmpSettings = {
    ...settings,
    agentDir,
    sessionDir: settings.sessionDir?.trim() || path.join(agentDir, "sessions"),
  };
  const scoped = ompEnvironment(configured, environment);
  yield* fs.makeDirectory(agentDir, { recursive: true });
  return { settings: configured, environment: scoped };
});
