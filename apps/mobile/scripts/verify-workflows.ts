import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isMap, isSeq, parseDocument } from "yaml";

import { MobilePackageVerificationError } from "./verification-error.ts";

export async function verifyMobileWorkflows(workflowsDir: string): Promise<void> {
  const failures: string[] = [];
  for (const filename of ["ci.yml", "mobile.yml"]) {
    const document = parseDocument(await readFile(join(workflowsDir, filename), "utf8"));
    const workflow = document.contents;
    if (document.errors.length > 0 || !isMap(workflow)) {
      failures.push(`${filename} must be a valid YAML workflow mapping`);
      continue;
    }
    const triggers = workflow.get("on", true);
    const jobs = workflow.get("jobs", true);
    if (!isMap(triggers) || !triggers.has("workflow_dispatch") || !isMap(jobs)) {
      failures.push(`${filename} must declare workflow_dispatch and jobs`);
      continue;
    }
    const push = triggers.get("push", true);
    const tags = isMap(push) ? push.get("tags", true) : undefined;
    if (
      filename === "mobile.yml" &&
      (!isSeq(tags) || !tags.items.some((tag) => String(tag) === "mobile-v*"))
    ) {
      failures.push("mobile.yml must trigger on mobile-v* tags");
    }
    const jobNames = filename === "mobile.yml" ? ["android-lite", "ios-ipa"] : ["core", "mobile"];
    for (const jobName of jobNames) {
      const job = jobs.get(jobName, true);
      const steps = isMap(job) ? job.get("steps", true) : undefined;
      if (!isMap(job) || !isSeq(steps)) {
        failures.push(`${filename} must declare ${jobName} steps`);
        continue;
      }
      const runs: string[] = [];
      const uploads: string[] = [];
      for (const step of steps.items) {
        if (!isMap(step)) {
          failures.push(`${filename}/${jobName} step must be a mapping`);
          continue;
        }
        const condition = step.get("if");
        if (typeof condition === "string" && condition.includes("secrets.")) {
          failures.push(`${filename}/${jobName} cannot use secrets directly in step if`);
        }
        const run = step.get("run");
        if (typeof run === "string") runs.push(run);
        const uses = step.get("uses");
        const withInputs = step.get("with", true);
        if (
          typeof uses === "string" &&
          uses.startsWith("actions/upload-artifact@") &&
          isMap(withInputs)
        ) {
          uploads.push(String(withInputs.get("path")));
        }
      }
      const commands = runs.join("\n");
      if (filename === "ci.yml") {
        const required =
          jobName === "core"
            ? ["pnpm typecheck", "pnpm test"]
            : [
                "pnpm --filter @cox/mobile typecheck",
                "pnpm mobile:test",
                "pnpm mobile:build",
                "pnpm --filter @cox/mobile verify:package",
                "pnpm mobile:smoke",
              ];
        for (const command of required) {
          if (!commands.includes(command))
            failures.push(`${filename}/${jobName} must run ${command}`);
        }
        continue;
      }
      const runner = jobName === "android-lite" ? "ubuntu-24.04" : "macos-15";
      if (job.get("runs-on") !== runner) failures.push(`${jobName} must run on ${runner}`);
      const required =
        jobName === "android-lite"
          ? [
              "pnpm --filter @cox/mobile build",
              "pnpm --filter @cox/mobile verify:package",
              "cap sync android",
              "testDebugUnitTest assembleDebug",
              "testDebugUnitTest assembleRelease",
              "-lt 20971520",
              "sha256sum *.apk > SHA256SUMS",
            ]
          : [
              "pnpm --filter @cox/mobile build",
              "pnpm --filter @cox/mobile verify:package",
              "cap copy ios",
              "-sdk iphoneos",
              "CoxMobile.xcarchive",
              "MARKETING_VERSION=",
              "CURRENT_PROJECT_VERSION=",
              "CODE_SIGNING_ALLOWED=NO",
              "CODE_SIGNING_REQUIRED=NO",
              "Products/Applications/App.app",
              "ipa/Payload/App.app",
              "zip -qry cox-mobile-unsigned.ipa Payload",
              "-exportArchive",
              "shasum -a 256 *.ipa > SHA256SUMS",
              "xcrun altool --upload-app",
            ];
      for (const command of required) {
        if (!commands.includes(command))
          failures.push(`${filename}/${jobName} must contain ${command}`);
      }
      if (!commands.includes("--release-dir"))
        failures.push(`${jobName} must verify release metadata`);
      if (
        !uploads.some((path) => path.includes("SHA256SUMS") || path.endsWith("/android-release/"))
      ) {
        failures.push(`${jobName} must upload SHA256SUMS alongside packages`);
      }
    }
  }
  if (failures.length > 0) throw new MobilePackageVerificationError(failures);
}
