import { makeBinaryPathSetting, makeProviderSettingsSchema } from "@t3tools/contracts";
import { PiSettings } from "@t3tools/provider-pi/settings";
import * as Schema from "effect/Schema";

export const OmpSettings = makeProviderSettingsSchema(
  {
    ...PiSettings.fields,
    binaryPath: makeBinaryPathSetting("omp").pipe(
      Schema.annotateKey({
        title: "Binary path",
        description: "Path to the Oh My Pi binary.",
        providerSettingsForm: { placeholder: "omp", clearWhenEmpty: "omit" },
      }),
    ),
    provider: PiSettings.fields.provider.pipe(
      Schema.annotateKey({
        title: "Model provider",
        description: "Oh My Pi provider ID. Leave empty to use the native configuration.",
        providerSettingsForm: { placeholder: "anthropic", clearWhenEmpty: "omit" },
      }),
    ),
    model: PiSettings.fields.model.pipe(
      Schema.annotateKey({
        title: "Default model",
        description:
          "Oh My Pi model ID or provider/model. Leave empty to inherit the native default.",
        providerSettingsForm: { placeholder: "provider/model", clearWhenEmpty: "omit" },
      }),
    ),
    apiKey: PiSettings.fields.apiKey.pipe(
      Schema.annotateKey({
        title: "API key",
        description:
          "Stored separately on this computer. Leave empty to use existing Oh My Pi credentials.",
        providerSettingsForm: { control: "password", clearWhenEmpty: "omit" },
      }),
    ),
    agentDir: PiSettings.fields.agentDir.pipe(
      Schema.annotateKey({
        title: "Oh My Pi configuration directory",
        description:
          "Optional absolute path for Oh My Pi credentials, models.yml and config.yml. Leave empty to use this Cox instance's configuration.",
        providerSettingsForm: { placeholder: "~/.omp/agent", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: PiSettings.fields.launchArgs.pipe(
      Schema.annotateKey({
        title: "Launch arguments",
        description: "Additional CLI arguments passed to omp on session start.",
        providerSettingsForm: { clearWhenEmpty: "omit" },
      }),
    ),
  },
  {
    order: ["provider", "model", "apiKey", "agentDir", "binaryPath", "launchArgs"],
  },
);
export type OmpSettings = typeof OmpSettings.Type;
