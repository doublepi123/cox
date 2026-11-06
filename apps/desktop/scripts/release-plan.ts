import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";
import {
  compareBackendVersions,
  fetchBackendRelease,
  isBackendVersion,
  record,
} from "../src/backend-install.ts";

export function latestDesktopTag(releases: readonly unknown[]): string {
  const versions = releases
    .flatMap((value) => {
      const release = record(value);
      const tag = release.tag_name;
      const version = typeof tag === "string" && tag.startsWith("desktop-v") ? tag.slice(9) : "";
      return !release.draft && !release.prerelease && isBackendVersion(version) ? [version] : [];
    })
    .sort((left, right) => compareBackendVersions(right, left));
  if (!versions[0])
    throw new Error(
      "Publish the first desktop-v release before requesting automatic Cox/client combination builds.",
    );
  return "desktop-v" + versions[0];
}

export interface DesktopReleasePlan {
  readonly client_ref: string;
  readonly client_commit: string;
  readonly client_version: string;
  readonly cox_version: string;
  readonly cox_integrity: string;
  readonly release_tag: string;
  readonly flavors: string;
  readonly publish: string;
  readonly client_release: string;
  readonly skip: string;
}

export async function resolveDesktopRelease(input: {
  readonly eventName: string;
  readonly refName: string;
  readonly event: unknown;
  readonly api: (path: string) => Promise<unknown>;
  readonly latest: (
    nodeVersion: string,
    minimum?: string,
    version?: string,
  ) => Promise<{ version: string; integrity: string }>;
}): Promise<DesktopReleasePlan> {
  const event = record(input.event);
  let clientRef: string;
  let releaseTag: string;
  let publish = true;
  let clientRelease = false;
  let includeClientOnly = false;
  let minimum: string | undefined;
  let backendVersion = "latest";
  if (input.eventName === "push") {
    if (!input.refName.startsWith("desktop-v") || !isBackendVersion(input.refName.slice(9)))
      throw new Error("A desktop-v<client-version> tag is required.");
    clientRef = input.refName;
    releaseTag = input.refName;
    clientRelease = true;
    includeClientOnly = true;
  } else if (input.eventName === "workflow_run") {
    const run = record(event.workflow_run);
    if (run.conclusion !== "success" || record(run.head_repository).full_name !== "doublepi123/cox")
      throw new Error(
        "Only successful official Cox npm publications can trigger combination releases.",
      );
    const artifacts = record(await input.api("actions/runs/" + run.id + "/artifacts"));
    const versions = (artifacts.artifacts as unknown[]).flatMap((value) => {
      const name = record(value).name;
      const version = typeof name === "string" && name.startsWith("cox-npm-v") ? name.slice(9) : "";
      return version ? [version] : [];
    });
    const names = versions.filter(isBackendVersion);
    if (
      names.length === 0 &&
      versions.length === 1 &&
      /^[0-9]+\.[0-9]+\.[0-9]+-[A-Za-z0-9.-]+$/.test(versions[0]!)
    )
      return {
        client_ref: "",
        client_commit: "",
        client_version: "",
        cox_version: "",
        cox_integrity: "",
        release_tag: "",
        flavors: "[]",
        publish: "false",
        client_release: "false",
        skip: "true",
      };
    if (names.length !== 1)
      throw new Error("The publishing run must identify exactly one stable Cox npm version.");
    minimum = names[0]!;
    releaseTag = "v" + minimum;
    const releases: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = await input.api("releases?per_page=100&page=" + page);
      if (!Array.isArray(result)) throw new Error("Invalid GitHub release inventory.");
      releases.push(...result);
      if (result.length < 100) break;
    }
    clientRef = latestDesktopTag(releases);
  } else if (input.eventName === "workflow_dispatch") {
    const inputs = record(event.inputs ?? {});
    clientRef =
      typeof inputs.client_ref === "string" && inputs.client_ref ? inputs.client_ref : "main";
    backendVersion =
      typeof inputs.cox_version === "string" && inputs.cox_version ? inputs.cox_version : "latest";
    publish = inputs.publish === "true" || inputs.publish === true;
    includeClientOnly = inputs.client_only === "true" || inputs.client_only === true;
    clientRelease = clientRef.startsWith("desktop-v");
    releaseTag = clientRef;
    if (publish && (!clientRelease || !isBackendVersion(clientRef.slice(9))))
      throw new Error("Manual publishing requires an existing desktop-v version tag.");
  } else throw new Error("Unsupported desktop release trigger.");
  if (!/^[A-Za-z0-9._/-]+$/.test(clientRef)) throw new Error("Invalid desktop source ref.");
  const sourceRef = clientRef.startsWith("desktop-v") ? "refs/tags/" + clientRef : clientRef;
  const commit = record(await input.api("commits/" + encodeURIComponent(sourceRef))).sha;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("The desktop source must resolve to an exact commit.");
  const content = record(await input.api("contents/apps/desktop/package.json?ref=" + commit));
  if (typeof content.content !== "string" || content.encoding !== "base64")
    throw new Error("The desktop manifest is unavailable at the selected source ref.");
  const manifest = record(JSON.parse(Buffer.from(content.content, "base64").toString("utf8")));
  if (!isBackendVersion(manifest.version))
    throw new Error("The desktop version must be a stable semantic version.");
  if (clientRef.startsWith("desktop-v") && clientRef !== "desktop-v" + manifest.version)
    throw new Error("The desktop tag must match apps/desktop/package.json.");
  const nodeVersion = record(manifest.engines).node;
  if (!isBackendVersion(nodeVersion)) throw new Error("The desktop must pin its own Node runtime.");
  const release = await input.latest(nodeVersion, minimum, backendVersion);
  return {
    client_ref: clientRef,
    client_commit: commit,
    client_version: manifest.version,
    cox_version: release.version,
    cox_integrity: release.integrity,
    release_tag: releaseTag,
    flavors: JSON.stringify(includeClientOnly ? ["bundled", "client-only"] : ["bundled"]),
    publish: String(publish),
    client_release: String(clientRelease),
    skip: "false",
  };
}

async function main() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, "utf8")) as unknown;
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GitHub authentication is required to resolve desktop releases.");
  const plan = await resolveDesktopRelease({
    eventName: process.env.GITHUB_EVENT_NAME!,
    refName: process.env.GITHUB_REF_NAME!,
    event,
    api: async (path) => {
      const response = await fetch("https://api.github.com/repos/doublepi123/cox/" + path, {
        headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error("GitHub release lookup failed: HTTP " + response.status);
      return response.json() as Promise<unknown>;
    },
    latest: async (nodeVersion, minimum, version) => {
      let failure: unknown;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          const release = await fetchBackendRelease(
            nodeVersion,
            AbortSignal.timeout(30_000),
            fetch,
            version,
          );
          if (minimum && compareBackendVersions(release.version, minimum) < 0)
            throw new Error("npm is still propagating the new Cox version.");
          if (!release.compatible)
            throw new Error("The latest Cox requires a newer compatible desktop client.");
          return { version: release.version, integrity: release.integrity };
        } catch (error) {
          failure = error;
        }
        if (attempt < 29) await setTimeout(30_000);
      }
      throw failure;
    },
  });
  for (const [key, value] of Object.entries(plan))
    await appendFile(process.env.GITHUB_OUTPUT!, key + "=" + value + "\n");
  console.log(JSON.stringify(plan, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
