import type { CodexSettings } from "@t3tools/contracts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

export function hasGatewayConfiguration(config: {
  readonly baseUrl?: string;
  readonly apiKey?: string;
}) {
  return Boolean(config.baseUrl?.trim() || config.apiKey?.trim());
}

export function gatewayBaseUrl(value: string | undefined, fallback: string): string {
  const url = new URL(value?.trim() || fallback);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("API URL must be an HTTP(S) base URL without credentials, query, or fragment.");
  }
  return url.href.replace(/\/+$/, "");
}

export function codexGatewayRuntime(config: CodexSettings, environment: NodeJS.ProcessEnv) {
  if (!hasGatewayConfiguration(config)) return { settings: config, environment };
  const baseUrl = gatewayBaseUrl(config.baseUrl, "https://api.openai.com/v1");
  const key = config.apiKey?.trim();
  const overrides = [
    'model_provider="cox_gateway"',
    'model_providers.cox_gateway.name="Cox Gateway"',
    `model_providers.cox_gateway.base_url=${JSON.stringify(baseUrl)}`,
    'model_providers.cox_gateway.wire_api="responses"',
    `model_providers.cox_gateway.env_key=${JSON.stringify(key ? "COX_CODEX_API_KEY" : "OPENAI_API_KEY")}`,
    "model_providers.cox_gateway.requires_openai_auth=false",
    ...(environment.COX_MODEL_SERVICE_KEY
      ? [
          "model_providers.cox_gateway.request_max_retries=0",
          "model_providers.cox_gateway.stream_max_retries=0",
        ]
      : []),
  ]
    .map((value) => `-c ${JSON.stringify(value)}`)
    .join(" ");
  const launchArgs =
    `${resolveCodexLaunchArgs(config.launchArgs, environment)} ${overrides}`.trim();
  return {
    settings: { ...config, launchArgs },
    environment: {
      ...environment,
      ...(key ? { COX_CODEX_API_KEY: key, OPENAI_API_KEY: key } : {}),
      T3CODE_CODEX_LAUNCH_ARGS: launchArgs,
    },
  };
}
