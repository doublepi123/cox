import { compareSemverVersions } from "@t3tools/shared/semver";

export const OMP_MINIMUM_VERSION = "18.20.2";
export const OMP_INSTALL_SPEC = "latest";

export function isSupportedOmpVersion(version: string): boolean {
  return compareSemverVersions(version, OMP_MINIMUM_VERSION) >= 0;
}
