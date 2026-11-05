import type { ProviderInstanceEnvironment, ProviderSessionId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

export function scopeModelServiceEnvironment(
  environment: NodeJS.ProcessEnv,
  sessionId: ProviderSessionId,
): NodeJS.ProcessEnv {
  const key = environment.COX_MODEL_SERVICE_KEY;
  if (!key) return environment;
  const scoped = `${key}.${sessionId}`;
  const next: NodeJS.ProcessEnv = { ...environment, COX_MODEL_SERVICE_KEY: scoped };
  for (const name of ["COX_CODEX_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    if (next[name] === key) next[name] = scoped;
  }
  if (next.OPENCODE_CONFIG_CONTENT) {
    const content: unknown = JSON.parse(next.OPENCODE_CONFIG_CONTENT);
    if (typeof content === "object" && content !== null) {
      const provider: unknown = Reflect.get(content, "provider");
      const cox: unknown =
        typeof provider === "object" && provider !== null
          ? Reflect.get(provider, "cox")
          : undefined;
      const options: unknown =
        typeof cox === "object" && cox !== null ? Reflect.get(cox, "options") : undefined;
      if (
        typeof options === "object" &&
        options !== null &&
        Reflect.get(options, "apiKey") === key
      ) {
        Reflect.set(options, "apiKey", scoped);
        next.OPENCODE_CONFIG_CONTENT = JSON.stringify(content);
      }
    }
  }
  return next;
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    // An unresolved secret reference carries no value; the registry resolves it for the provider.
    if (typeof variable.value !== "string") continue;
    next[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return next;
});
