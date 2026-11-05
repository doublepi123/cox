import type { PiSettings } from "../settings.ts";
import { resolvePiLaunchArgs, type PiLaunchArgsResolution } from "./mcpInjection.ts";

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

function modelProvider(settings: PiSettings): string | undefined {
  return settings.provider?.trim() || settings.model?.split("/")[0];
}

export function piEnvironment(
  settings: PiSettings,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const variable = API_KEY_VARIABLES[modelProvider(settings) ?? ""];
  return {
    ...environment,
    ...(settings.agentDir?.trim() ? { PI_CODING_AGENT_DIR: settings.agentDir.trim() } : {}),
    ...(settings.apiKey?.trim() && variable ? { [variable]: settings.apiKey.trim() } : {}),
  };
}

export function configuredPiLaunchArgs(settings: PiSettings): PiLaunchArgsResolution {
  const resolved = resolvePiLaunchArgs(settings.launchArgs);
  if (!resolved.ok) return resolved;
  if (settings.apiKey?.trim() && !API_KEY_VARIABLES[modelProvider(settings) ?? ""])
    return {
      ok: false,
      message:
        "Select a supported Pi model provider before adding an API key. For custom providers, configure credentials in Pi's models.json or provider environment.",
    };
  return {
    ok: true,
    args: [
      ...(resolved.args.some((arg) => ["--approve", "-a", "--no-approve", "-na"].includes(arg))
        ? []
        : ["--approve"]),
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
