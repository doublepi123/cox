import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "Oh My Pi",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [{ d: "M4 5h16v2.6H4Z" }, { d: "M6 8.6h2.6V19H6Z" }, { d: "M15.4 8.6h2.6V19h-2.6Z" }],
  },
});
