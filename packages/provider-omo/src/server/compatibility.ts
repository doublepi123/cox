import { compareSemverVersions } from "@t3tools/shared/semver";

export const OMO_MINIMUM_VERSION = "5.1.69";
export const OMO_INSTALL_SPEC = "latest";
export const OMO_PERMISSION_CAPABILITY = "set_permission_preset_v1";

export function isSupportedOmoVersion(version: string): boolean {
  return compareSemverVersions(version, OMO_MINIMUM_VERSION) >= 0;
}
