// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node filesystem build boundary.

import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  MobilePackageVerificationError,
  verifyMobilePackage,
  verifyMobileReleaseMetadata,
  type MobilePackagePaths,
} from "../scripts/verify-package.ts";

const pbxprojTemplate = [
  "/* Begin PBXBuildFile section */",
  "\t\tBB1000000000000000000001 /* CoxLauncherViewController.swift in Sources */ = {isa = PBXBuildFile; fileRef = BB2000000000000000000001; };",
  "\t\tBB1000000000000000000002 /* CoxWorkspaceWebViewPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = BB2000000000000000000002; };",
  "\t\tBB1000000000000000000003 /* CoxVaultPlugin.swift in Sources */ = {isa = PBXBuildFile; fileRef = BB2000000000000000000003; };",
  "/* End PBXBuildFile section */",
  "/* Begin PBXFileReference section */",
  '\t\tBB2000000000000000000001 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CoxLauncherViewController.swift; sourceTree = "<group>"; };',
  '\t\tBB2000000000000000000002 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CoxWorkspaceWebViewPlugin.swift; sourceTree = "<group>"; };',
  '\t\tBB2000000000000000000003 = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = CoxVaultPlugin.swift; sourceTree = "<group>"; };',
  "/* End PBXFileReference section */",
  "/* Begin PBXSourcesBuildPhase section */",
  "\t\tBB3000000000000000000001 /* Sources */ = {",
  "\t\t\tisa = PBXSourcesBuildPhase;",
  "\t\t\tfiles = (",
  "\t\t\t\tBB1000000000000000000001,",
  "\t\t\t\tBB1000000000000000000002,",
  "\t\t\t\tBB1000000000000000000003,",
  "\t\t\t);",
  "\t\t};",
  "/* End PBXSourcesBuildPhase section */",
  "\t\t\t\tIPHONEOS_DEPLOYMENT_TARGET = 17.0;",
  "\t\t\t\tPRODUCT_BUNDLE_IDENTIFIER = dev.doublepi.cox.mobile;",
].join("\n");

const buildGradleTemplate = [
  "apply plugin: 'com.android.application'",
  "android {",
  "    defaultConfig {",
  '        applicationId "dev.doublepi.cox.mobile"',
  "        minSdkVersion rootProject.ext.minSdkVersion",
  "        targetSdkVersion rootProject.ext.targetSdkVersion",
  "    }",
  "    dependencies {",
  "        implementation 'androidx.webkit:webkit:1.12.1'",
  "        implementation 'androidx.biometric:biometric:1.1.0'",
  "        implementation 'androidx.security:security-crypto:1.1.0-alpha06'",
  "    }",
  "}",
].join("\n");

const variablesGradleTemplate = [
  "ext {",
  "    minSdkVersion = 26",
  "    targetSdkVersion = 35",
  "}",
].join("\n");

const infoPlistTemplate = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<plist version="1.0">',
  "<dict>",
  "\t<key>ITSAppUsesNonExemptEncryption</key>",
  "\t<false/>",
  "\t<key>NSCameraUsageDescription</key>",
  "\t<string>Scan a Cox server QR code to fill its connection URL.</string>",
  "\t<key>NSFaceIDUsageDescription</key>",
  "\t<string>Use Face ID to unlock saved Cox server passwords.</string>",
  "</dict>",
  "</plist>",
].join("\n");

const tempRoots: string[] = [];

async function createPackageFixture(): Promise<MobilePackagePaths> {
  const root = await mkdtemp(join(tmpdir(), "cox-mobile-package-"));
  tempRoots.push(root);
  await mkdir(join(root, "dist", "assets"), { recursive: true });
  await writeFile(join(root, "dist", "index.html"), "<!doctype html><title>Cox</title>", "utf8");
  await writeFile(
    join(root, "dist", "assets", "launcher-abc123.js"),
    "console.log('launcher');",
    "utf8",
  );
  await mkdir(join(root, "android", "app"), { recursive: true });
  await writeFile(join(root, "android", "app", "build.gradle"), buildGradleTemplate, "utf8");
  await writeFile(join(root, "android", "variables.gradle"), variablesGradleTemplate, "utf8");
  await mkdir(join(root, "ios", "App", "App"), { recursive: true });
  await mkdir(join(root, "ios", "App", "App.xcodeproj"), { recursive: true });
  await writeFile(join(root, "ios", "App", "App", "Info.plist"), infoPlistTemplate, "utf8");
  await writeFile(
    join(root, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    pbxprojTemplate,
    "utf8",
  );
  return {
    distDir: join(root, "dist"),
    iosPbxprojPath: join(root, "ios", "App", "App.xcodeproj", "project.pbxproj"),
    androidGradlePath: join(root, "android", "app", "build.gradle"),
  };
}

async function verificationFailure(
  paths: MobilePackagePaths,
): Promise<MobilePackageVerificationError> {
  try {
    await verifyMobilePackage(paths);
  } catch (error) {
    if (error instanceof MobilePackageVerificationError) return error;
    throw error;
  }
  throw new Error("verifyMobilePackage accepted a package that must be rejected");
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("mobile package verification", () => {
  it("accepts a remote-only dist with compliant native configurations", async () => {
    const paths = await createPackageFixture();

    const names = await verifyMobilePackage(paths);

    expect(names).toContain("index.html");
    expect(names.some((name) => name.endsWith(".js"))).toBe(true);
  });

  it.each([
    ["@clerk/clerk-js", "@clerk/"],
    ["@t3tools/web", "@t3tools/web"],
    ["GhosttyTerminal", "GhosttyTerminal"],
    ['require("child_process")', "child_process"],
  ])("rejects dist content containing %s", async (chunk, marker) => {
    const paths = await createPackageFixture();
    await writeFile(join(paths.distDir, "assets", "vendor-dummy.js"), chunk, "utf8");

    const failure = await verificationFailure(paths);

    expect(failure.message).toContain("vendor-dummy.js");
    expect(failure.message).toContain(`"${marker}"`);
  });

  it.each([
    ["index.html", "index.html"],
    ["assets/launcher-abc123.js", "bundled JavaScript assets"],
  ])("rejects a dist missing %s", async (removed, fragment) => {
    const paths = await createPackageFixture();
    await rm(join(paths.distDir, removed));

    const failure = await verificationFailure(paths);

    expect(failure.message).toContain(fragment);
  });

  it("rejects an Xcode project that drops the vault plugin from the Sources phase", async () => {
    const paths = await createPackageFixture();
    await writeFile(
      paths.iosPbxprojPath,
      pbxprojTemplate.replace("\t\t\t\tBB1000000000000000000003,\n", ""),
      "utf8",
    );

    const failure = await verificationFailure(paths);

    expect(failure.message).toContain("CoxVaultPlugin.swift");
    expect(failure.message).toContain("PBXSourcesBuildPhase");
  });

  it("rejects an Android configuration below the SDK floor", async () => {
    const paths = await createPackageFixture();
    await writeFile(
      join(paths.androidGradlePath, "..", "..", "variables.gradle"),
      variablesGradleTemplate.replace("minSdkVersion = 26", "minSdkVersion = 24"),
      "utf8",
    );

    const failure = await verificationFailure(paths);

    expect(failure.message).toContain("minSdkVersion = 26");
  });

  it.each([
    ["<false/>", "<true/>", "ITSAppUsesNonExemptEncryption"],
    [
      "<string>Use Face ID to unlock saved Cox server passwords.</string>",
      "<string>   </string>",
      "NSFaceIDUsageDescription",
    ],
    [
      "<string>Scan a Cox server QR code to fill its connection URL.</string>",
      "<string></string>",
      "NSCameraUsageDescription",
    ],
  ])("rejects an iOS Info.plist with invalid %s", async (original, replacement, reason) => {
    const paths = await createPackageFixture();
    await writeFile(
      join(paths.iosPbxprojPath, "..", "..", "App", "Info.plist"),
      infoPlistTemplate.replace(original, replacement),
      "utf8",
    );

    const failure = await verificationFailure(paths);

    expect(failure.message).toContain(reason);
  });

  it.each([
    ["workflow_dispatch:", "invalid_trigger:", "workflow_dispatch"],
    ['"mobile-v*"', '"desktop-v*"', "mobile-v*"],
    ["android-lite:", "android:", "android-lite"],
    ["-lt 20971520", "-le 20971520", "20971520"],
    ["zip -qry cox-mobile-unsigned.ipa Payload", "true", "Payload"],
    ["sha256sum *.apk > SHA256SUMS", "true", "SHA256SUMS"],
    ["CURRENT_PROJECT_VERSION=", "BUILD_NUMBER_UNUSED=", "CURRENT_PROJECT_VERSION="],
    ["xcode-select -s", "echo default_xcode", "xcode-select -s"],
    ["xcrun altool --upload-app", "echo skipped", "xcrun altool --upload-app"],
    ["if: steps.signing.outputs.signed == 'true'", "if: secrets.CERT != ''", "secrets"],
  ])("rejects a release workflow with broken %s", async (original, replacement, reason) => {
    const paths = await createPackageFixture();
    const workflowsDir = join(paths.distDir, "..", "workflows");
    await cp(join(import.meta.dirname, "../../../.github/workflows"), workflowsDir, {
      recursive: true,
    });
    const workflowPath = join(workflowsDir, "mobile.yml");
    const workflow = await readFile(workflowPath, "utf8");
    await writeFile(workflowPath, workflow.replaceAll(original, replacement));

    const failure = await verificationFailure({ ...paths, workflowsDir });

    expect(failure.message).toContain(reason);
  });
});

describe("mobile release metadata verification", () => {
  async function createReleaseFixture(size = 3): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "cox-mobile-release-"));
    tempRoots.push(directory);
    const bytes = Buffer.alloc(size, 42);
    await writeFile(join(directory, "cox.apk"), bytes);
    await writeFile(
      join(directory, "release-metadata.json"),
      JSON.stringify({ applicationId: "dev.doublepi.cox.mobile" }),
    );
    await writeFile(
      join(directory, "SHA256SUMS"),
      `${createHash("sha256").update(bytes).digest("hex")}  cox.apk\n`,
    );
    return directory;
  }

  it("accepts a package below the size limit with matching checksums and identity", async () => {
    const directory = await createReleaseFixture(20 * 1024 * 1024 - 1);

    await expect(verifyMobileReleaseMetadata(directory)).resolves.toBeUndefined();
  });

  it.each([
    ["missing SHA256SUMS", async (dir: string) => rm(join(dir, "SHA256SUMS")), "SHA256SUMS"],
    [
      "checksum mismatch",
      async (dir: string) => writeFile(join(dir, "cox.apk"), "tampered"),
      "checksum mismatch",
    ],
    [
      "CoCode identity collision",
      async (dir: string) =>
        writeFile(join(dir, "release-metadata.json"), '{"applicationId":"io.cocode.app"}'),
      "applicationId",
    ],
  ])("rejects %s", async (_name, corrupt, reason) => {
    const directory = await createReleaseFixture();
    await corrupt(directory);

    await expect(verifyMobileReleaseMetadata(directory)).rejects.toThrow(reason);
  });

  it("rejects an APK at exactly the 20 MB limit with a matching checksum", async () => {
    const directory = await createReleaseFixture(20 * 1024 * 1024);

    await expect(verifyMobileReleaseMetadata(directory)).rejects.toThrow("smaller than 20 MB");
  });
});
