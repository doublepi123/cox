import { expect, it } from "vite-plus/test";
import { desktopElectronFuses } from "./package-fuses.ts";

it.each([
  ["win32", false, false],
  ["linux", false, false],
  ["darwin", false, true],
  ["darwin", true, false],
] as const)("configures inspector flags for %s with signing=%s", (platform, signed, reset) => {
  expect(desktopElectronFuses(platform, signed)).toEqual({
    enableNodeCliInspectArguments: false,
    resetAdHocDarwinSignature: reset,
  });
});
