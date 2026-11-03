// Shared with the client settings form; keep schema code browser-safe.
import {
  CustomModelSetting,
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  secretSetting,
  TrimmedString,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: makeBinaryPathSetting("pi").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Pi coding agent binary.",
        providerSettingsForm: { placeholder: "pi", clearWhenEmpty: "omit" },
      }),
    ),
    provider: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Model provider",
        description:
          "Pi provider ID, such as anthropic, openai, google or openrouter. Leave empty to use Pi's configuration.",
        providerSettingsForm: { placeholder: "anthropic", clearWhenEmpty: "omit" },
      }),
    ),
    model: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Default model",
        description: "Pi model ID or provider/model. Leave empty to use Pi's default model.",
        providerSettingsForm: { placeholder: "provider/model", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: Schema.optionalKey(TrimmedString).pipe(
      secretSetting,
      Schema.annotateKey({
        title: "API key",
        description:
          "Stored separately on this computer. Select a model provider before adding a Pi API key. Leave empty to use existing Pi credentials or environment variables.",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    agentDir: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Pi configuration directory",
        description:
          "Optional absolute path for Pi credentials, models.json and settings.json. Leave empty to use PI_CODING_AGENT_DIR or ~/.pi/agent.",
        providerSettingsForm: { placeholder: "~/.pi/agent", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to pi --mode rpc on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["provider", "model", "apiKey", "agentDir", "binaryPath", "launchArgs"],
  },
);
export type PiSettings = typeof PiSettings.Type;
