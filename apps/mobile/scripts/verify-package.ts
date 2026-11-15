import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { MobilePackageVerificationError } from "./verification-error.ts";
import { verifyMobileReleaseMetadata } from "./verify-release.ts";
import { verifyMobileWorkflows } from "./verify-workflows.ts";

export { MobilePackageVerificationError, verifyMobileReleaseMetadata };

export type MobilePackagePaths = {
  readonly distDir: string;
  readonly iosPbxprojPath: string;
  readonly androidGradlePath: string;
  readonly workflowsDir?: string;
  readonly releaseDir?: string;
};

const forbiddenDistMarkers = [
  { marker: "_chat.settings", reason: "workspace chat route bundle" },
  { marker: "GhosttyTerminal", reason: "workspace terminal component" },
  { marker: "DiffPanel", reason: "workspace diff component" },
  { marker: "node-pty", reason: "local terminal spawner" },
  { marker: "cox-protocol-bridge", reason: "local protocol bridge" },
  { marker: "apps/server/dist", reason: "local server bundle" },
  { marker: "child_process", reason: "local process spawner" },
  { marker: "@clerk/", reason: "cloud account service" },
  { marker: "@t3tools/web", reason: "workspace web package" },
  { marker: "cloudflare-tunnel", reason: "relay tunnel infrastructure" },
  { marker: "t3-connect", reason: "cloud connect service" },
  { marker: "proot", reason: "local root filesystem runtime" },
  { marker: "alpine", reason: "local Linux root filesystem artifact" },
] as const;

const requiredAndroidGradleLines = [
  'applicationId "dev.doublepi.cox.mobile"',
  "minSdkVersion rootProject.ext.minSdkVersion",
  "targetSdkVersion rootProject.ext.targetSdkVersion",
  "androidx.webkit",
  "androidx.biometric",
  "androidx.security",
] as const;

const requiredAndroidVariableLines = ["minSdkVersion = 26", "targetSdkVersion = 35"] as const;

const requiredIosPbxprojLines = [
  "IPHONEOS_DEPLOYMENT_TARGET = 17.0;",
  "PRODUCT_BUNDLE_IDENTIFIER = dev.doublepi.cox.mobile;",
] as const;

const requiredIosSourceFiles = [
  "CoxLauncherViewController.swift",
  "CoxWorkspaceWebViewPlugin.swift",
  "CoxVaultPlugin.swift",
] as const;

function missingLines(content: string, lines: readonly string[]): readonly string[] {
  return lines.filter((line) => !content.includes(line));
}

async function readTextFile(path: string, label: string, failures: string[]): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    failures.push(
      `${label} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return "";
  }
}

async function listFilesRecursive(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFilesRecursive(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function verifyDist(distDir: string, failures: string[]): Promise<readonly string[]> {
  let files: readonly string[];
  try {
    const info = await stat(distDir);
    if (!info.isDirectory()) throw new Error("not a directory");
    files = await listFilesRecursive(distDir);
  } catch (error) {
    failures.push(
      `dist directory cannot be inspected: ${distDir} (${error instanceof Error ? error.message : String(error)})`,
    );
    return [];
  }
  const names = files.map((file) => relative(distDir, file));
  for (const line of missingLines(names.join("\n"), ["index.html"])) {
    failures.push(`dist must contain "${line}"`);
  }
  if (!names.some((name) => name.endsWith(".js"))) {
    failures.push("dist must contain bundled JavaScript assets");
  }
  for (const file of files) {
    const name = relative(distDir, file);
    const bytes = await readFile(file);
    for (const { marker, reason } of forbiddenDistMarkers) {
      if (name.includes(marker) || bytes.includes(marker)) {
        failures.push(`dist/${name} contains forbidden "${marker}" (${reason})`);
      }
    }
  }
  return names;
}

function verifyIosProject(pbxproj: string, failures: string[]): void {
  for (const line of missingLines(pbxproj, requiredIosPbxprojLines)) {
    failures.push(`ios/App/App.xcodeproj/project.pbxproj must contain "${line}"`);
  }
  const sourcesPhases = [...pbxproj.matchAll(/\/\* Sources \*\/ = \{[^}]*\};/g)].map(
    (match) => match[0] ?? "",
  );
  for (const filename of requiredIosSourceFiles) {
    const fileReference = pbxproj.match(
      new RegExp(`([0-9A-F]{24})[^\\n]*= \\{isa = PBXFileReference;[^\\n]*path = ${filename};`),
    );
    if (fileReference?.[1] === undefined) {
      failures.push(`project.pbxproj has no PBXFileReference for ${filename}`);
      continue;
    }
    const buildFile = pbxproj.match(
      new RegExp(`([0-9A-F]{24})[^\\n]*= \\{isa = PBXBuildFile; fileRef = ${fileReference[1]};`),
    );
    if (buildFile?.[1] === undefined) {
      failures.push(`project.pbxproj has no PBXBuildFile for ${filename}`);
      continue;
    }
    if (!sourcesPhases.some((phase) => phase.includes(buildFile[1] ?? ""))) {
      failures.push(`project.pbxproj is missing ${filename} in the App PBXSourcesBuildPhase`);
    }
  }
}

async function verifyAndroidProject(gradlePath: string, failures: string[]): Promise<void> {
  const gradle = await readTextFile(gradlePath, "android/app/build.gradle", failures);
  for (const line of missingLines(gradle, requiredAndroidGradleLines)) {
    failures.push(`android/app/build.gradle must contain "${line}"`);
  }
  const variablesPath = join(dirname(gradlePath), "..", "variables.gradle");
  const variables = await readTextFile(variablesPath, "android/variables.gradle", failures);
  for (const line of missingLines(variables, requiredAndroidVariableLines)) {
    failures.push(`android/variables.gradle must contain "${line}"`);
  }
}

export async function verifyMobilePackage(paths: MobilePackagePaths): Promise<readonly string[]> {
  const failures: string[] = [];
  const distNames = await verifyDist(paths.distDir, failures);
  const pbxproj = await readTextFile(
    paths.iosPbxprojPath,
    "ios/App/App.xcodeproj/project.pbxproj",
    failures,
  );
  verifyIosProject(pbxproj, failures);
  await verifyAndroidProject(paths.androidGradlePath, failures);
  if (failures.length > 0) throw new MobilePackageVerificationError(failures);
  await verifyMobileWorkflows(
    paths.workflowsDir ?? resolve(packageRoot, "../../.github/workflows"),
  );
  if (paths.releaseDir !== undefined) await verifyMobileReleaseMetadata(paths.releaseDir);
  return distNames;
}

const packageRoot = resolve(import.meta.dirname, "..");

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values, positionals } = parseArgs({
    options: { "release-dir": { type: "string" } },
    allowPositionals: true,
  });
  const paths: MobilePackagePaths = {
    distDir: positionals[0] === undefined ? join(packageRoot, "dist") : resolve(positionals[0]),
    iosPbxprojPath: join(packageRoot, "ios/App/App.xcodeproj/project.pbxproj"),
    androidGradlePath: join(packageRoot, "android/app/build.gradle"),
    ...(values["release-dir"] === undefined ? {} : { releaseDir: resolve(values["release-dir"]) }),
  };
  try {
    const names = await verifyMobilePackage(paths);
    console.log(
      `PASS: ${names.length} dist files stay remote-only; native configurations, workflows and supplied release metadata are valid.`,
    );
  } catch (error) {
    if (!(error instanceof MobilePackageVerificationError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
