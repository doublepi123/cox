import type { Configuration } from "electron-builder";

export function desktopElectronFuses(
  platform: NodeJS.Platform,
  signingIdentityConfigured: boolean,
): NonNullable<Configuration["electronFuses"]> {
  return {
    enableNodeCliInspectArguments: false,
    resetAdHocDarwinSignature: platform === "darwin" && !signingIdentityConfigured,
  };
}
