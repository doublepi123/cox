import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { OmoSettings } from "./settings.ts";

export const omoClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omo"),
  label: "OMO Native",
  settingsSchema: OmoSettings,
});
