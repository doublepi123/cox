import {
  makeBinaryPathSetting,
  makeProviderSettingsSchema,
  TrimmedString,
  OmoRoleName,
  OmoRecommendationPrompt,
} from "@t3tools/contracts";
import { PiSettings } from "@t3tools/provider-pi/settings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export { OmoRoleName } from "@t3tools/contracts";
const isOmoRoleName = Schema.is(OmoRoleName);

const OmoRoleModels = Schema.Record(Schema.String, TrimmedString)
  .check(Schema.makeFilter((roles) => Object.keys(roles).every(isOmoRoleName)))
  .pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  );

export const OmoSettings = makeProviderSettingsSchema(
  {
    ...PiSettings.fields,
    binaryPath: makeBinaryPathSetting("omo").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the OMO Native binary.",
        providerSettingsForm: { placeholder: "omo", clearWhenEmpty: "omit" },
      }),
    ),
    provider: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Model provider",
        description: "OMO provider ID. Leave empty to use the native configuration.",
        providerSettingsForm: { placeholder: "anthropic", clearWhenEmpty: "omit" },
      }),
    ),
    model: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "Default model",
        description: "OMO model ID or provider/model. Leave empty to inherit the native default.",
        providerSettingsForm: { placeholder: "provider/model", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: PiSettings.fields.apiKey.pipe(
      Schema.annotateKey({
        title: "API key",
        description:
          "Stored separately on this computer. Leave empty to use existing OMO credentials.",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    agentDir: Schema.optionalKey(TrimmedString).pipe(
      Schema.annotateKey({
        title: "OMO configuration directory",
        description: "Optional absolute path for OMO credentials, models.json and native settings.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to OMO Native on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
    agentModels: OmoRoleModels,
    categoryModels: OmoRoleModels,
    recommendationPrompt: OmoRecommendationPrompt.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    modelServiceManaged: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  { order: ["provider", "model", "apiKey", "agentDir", "binaryPath", "launchArgs"] },
);
export type OmoSettings = typeof OmoSettings.Type;
