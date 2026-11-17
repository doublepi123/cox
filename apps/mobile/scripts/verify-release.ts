import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { MobilePackageVerificationError } from "./verification-error.ts";

export async function verifyMobileReleaseMetadata(releaseDir: string): Promise<void> {
  try {
    const failures: string[] = [];
    const metadata: unknown = JSON.parse(
      await readFile(join(releaseDir, "release-metadata.json"), "utf8"),
    );
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      !("applicationId" in metadata) ||
      metadata.applicationId !== "dev.doublepi.cox.mobile"
    ) {
      failures.push(
        "release applicationId must be dev.doublepi.cox.mobile; io.cocode.app is reserved",
      );
    }
    const sums = await readFile(join(releaseDir, "SHA256SUMS"), "utf8");
    const checksums = new Map<string, string>();
    for (const line of sums.trim().split("\n")) {
      const match = /^([a-fA-F0-9]{64}) [ *]([^/\\]+[.](?:apk|ipa))$/.exec(line);
      if (match?.[1] === undefined || match[2] === undefined || checksums.has(match[2])) {
        failures.push("SHA256SUMS must list unique APK/IPA filenames with SHA256 digests");
      } else {
        checksums.set(match[2], match[1].toLowerCase());
      }
    }
    const artifacts = (await readdir(releaseDir)).filter((name) => /\.(apk|ipa)$/.test(name));
    if (artifacts.length === 0) failures.push("release directory must contain an APK or IPA");
    for (const name of artifacts) {
      const path = join(releaseDir, name);
      if (name.endsWith(".apk") && (await stat(path)).size >= 20 * 1024 * 1024) {
        failures.push(`${name} must be smaller than 20 MB (20971520 bytes)`);
      }
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      if (checksums.get(name) !== digest) failures.push(`SHA256SUMS checksum mismatch for ${name}`);
    }
    for (const name of checksums.keys()) {
      if (!artifacts.includes(name))
        failures.push(`SHA256SUMS references missing artifact ${name}`);
    }
    if (failures.length > 0) throw new MobilePackageVerificationError(failures);
  } catch (error) {
    if (error instanceof MobilePackageVerificationError) throw error;
    if (!(error instanceof Error)) throw error;
    throw new MobilePackageVerificationError([`release metadata cannot be read: ${error.message}`]);
  }
}
