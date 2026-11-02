import type { Settings as ClaudeSdkSettings } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { gatewayBaseUrl, hasGatewayConfiguration } from "./gatewayConfiguration.ts";

const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

class ClaudeGatewaySettingsError extends Data.TaggedError("ClaudeGatewaySettingsError")<{
  readonly message: string;
}> {}

export const materializeClaudeGatewaySettings = Effect.fn("materializeClaudeGatewaySettings")(
  function* (
    config: Pick<ClaudeSettings, "baseUrl" | "apiKey">,
    settings: string | ClaudeSdkSettings | undefined,
  ) {
    if (!hasGatewayConfiguration(config)) return settings;
    const fs = yield* FileSystem.FileSystem;
    const current =
      typeof settings === "string"
        ? yield* fs.readFileString(settings).pipe(Effect.flatMap(decodeSettings))
        : (settings ?? {});
    const oldEnvironment =
      typeof current.env === "object" && current.env !== null ? current.env : {};
    const baseUrl = config.baseUrl?.trim();
    const key = config.apiKey?.trim();
    const environment = {
      ...oldEnvironment,
      ANTHROPIC_BASE_URL: gatewayBaseUrl(baseUrl, "https://api.anthropic.com").replace(/\/v1$/, ""),
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ...(key ? { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: "" } : {}),
    };
    const file = yield* fs.makeTempFileScoped({ prefix: "cox-claude-gateway-", suffix: ".json" });
    yield* fs.chmod(file, 0o600);
    const contents = yield* encodeSettings({ ...current, env: environment });
    yield* fs.writeFileString(file, contents);
    return file;
  },
  Effect.mapError(
    () => new ClaudeGatewaySettingsError({ message: "Failed to prepare Claude gateway settings." }),
  ),
);
