import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";
import { cursorClient } from "@t3tools/provider-cursor/client";

import { CursorCliSettings } from "./settings.ts";

export const cursorCliClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("cursorCli"),
  label: "Cursor CLI",
  settingsSchema: CursorCliSettings,
  environmentFields: [
    {
      name: "CURSOR_API_KEY",
      label: "Cursor API key",
      description: "Optional. Overrides the Cursor CLI login for this provider.",
      placeholder: "Paste API key",
      sensitive: true,
    },
  ],
  icon: cursorClient.icon,
});
