import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { materializeClaudeGatewaySettings } from "./ClaudeGatewaySettings.ts";

const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

it.layer(NodeServices.layer)("Claude gateway settings", (it) => {
  describe("credential precedence", () => {
    it.effect(
      "gives the model service its retry and timeout policy over user environment settings",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const file = yield* materializeClaudeGatewaySettings(
            { baseUrl: "http://127.0.0.1/api/model-gateway/v1", apiKey: "local-token.session-a" },
            { env: { CLAUDE_CODE_MAX_RETRIES: "20", API_TIMEOUT_MS: "1000" } },
            { COX_MODEL_SERVICE_KEY: "local-token.session-a", API_TIMEOUT_MS: "330000" },
          );
          if (typeof file !== "string") throw new Error("Expected gateway settings");
          expect(decodeSettings(yield* fs.readFileString(file)).env).toMatchObject({
            CLAUDE_CODE_MAX_RETRIES: "0",
            API_TIMEOUT_MS: "330000",
            ANTHROPIC_API_KEY: "local-token.session-a",
          });
        }).pipe(Effect.scoped),
    );
    it.effect("keeps subscription settings unchanged", () =>
      Effect.gen(function* () {
        const settings = { disableAllHooks: true };
        expect(yield* materializeClaudeGatewaySettings({}, settings).pipe(Effect.scoped)).toBe(
          settings,
        );
        expect(
          yield* materializeClaudeGatewaySettings({}, undefined).pipe(Effect.scoped),
        ).toBeUndefined();
      }),
    );

    it.effect("writes private merged settings and removes them after scope closes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* Effect.gen(function* () {
          const result = yield* materializeClaudeGatewaySettings(
            { baseUrl: "https://gateway.test/v1", apiKey: "configured-key" },
            {
              disableAllHooks: true,
              env: {
                ANTHROPIC_BASE_URL: "https://old.test",
                ANTHROPIC_API_KEY: "old-key",
                CLAUDE_CODE_OAUTH_TOKEN: "subscription-token",
                RETAINED: "value",
              },
            },
          );
          expect(typeof result).toBe("string");
          if (typeof result !== "string") return "";
          expect(result).not.toContain("configured-key");
          expect((yield* fs.stat(result)).mode & 0o777).toBe(0o600);
          expect(decodeSettings(yield* fs.readFileString(result))).toEqual({
            disableAllHooks: true,
            env: {
              ANTHROPIC_BASE_URL: "https://gateway.test",
              ANTHROPIC_API_KEY: "configured-key",
              ANTHROPIC_AUTH_TOKEN: "",
              CLAUDE_CODE_OAUTH_TOKEN: "",
              RETAINED: "value",
            },
          });
          return result;
        }).pipe(Effect.scoped);
        expect(yield* fs.exists(file)).toBe(false);
      }),
    );

    it.effect("uses the official endpoint for a key-only configuration", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* materializeClaudeGatewaySettings(
          { apiKey: "configured-key" },
          { env: { ANTHROPIC_BASE_URL: "https://old.test" } },
        );
        if (typeof file !== "string") throw new Error("Expected a private settings file");
        const settings = decodeSettings(yield* fs.readFileString(file));
        expect(settings.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
      }).pipe(Effect.scoped),
    );

    it.effect("sanitizes malformed settings errors", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const file = yield* fs.makeTempFileScoped();
        yield* fs.writeFileString(file, '{"secret":"sensitive-key", malformed');
        const error = yield* materializeClaudeGatewaySettings(
          { apiKey: "configured-key" },
          file,
        ).pipe(Effect.flip);
        expect(error.message).toBe("Failed to prepare Claude gateway settings.");
        expect(String(error)).not.toContain("sensitive-key");
        expect(error).not.toHaveProperty("cause");
      }).pipe(Effect.scoped),
    );
  });
});
