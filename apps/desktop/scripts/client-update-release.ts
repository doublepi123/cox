import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isBackendVersion, record } from "../src/backend-install.ts";
import {
  clientUpdateFlavors,
  clientUpdateTargets,
  parseClientUpdateFeed,
  type ClientUpdateFeed,
} from "../src/client-updates.ts";

interface DesktopReleaseAsset {
  readonly name: string;
  readonly size: number;
  readonly digest: string;
}

export function planDesktopAssetUploads(
  local: readonly DesktopReleaseAsset[],
  existing: readonly DesktopReleaseAsset[],
) {
  const upload: string[] = [];
  for (const asset of local) {
    if (!/^[A-Za-z0-9._-]+$/.test(asset.name))
      throw new Error("Invalid desktop release asset name.");
    const previous = existing.find((candidate) => candidate.name === asset.name);
    if (!previous) upload.push(asset.name);
    else if (previous.size !== asset.size || previous.digest !== asset.digest)
      throw new Error("Refusing to overwrite immutable desktop release asset: " + asset.name);
  }
  return { upload };
}

export async function versionDesktopMetadata(directory: string) {
  for (const name of await readdir(directory)) {
    const match = /^(BUILD|UPDATE)-(bundled|client-only)-(darwin|win32)-(arm64|x64)\.json$/.exec(
      name,
    );
    if (!match) continue;
    const metadata = record(JSON.parse(await readFile(join(directory, name), "utf8")));
    const backend = match[1] === "BUILD" ? metadata.coxVersion : metadata.backendVersion;
    if (
      !isBackendVersion(metadata.version) ||
      (match[2] === "bundled" ? !isBackendVersion(backend) : backend !== null)
    )
      throw new Error("Invalid desktop build metadata identity.");
    const suffix = `-client-${metadata.version}` + (backend === null ? "" : `-cox-${backend}`);
    await rename(join(directory, name), join(directory, name.slice(0, -5) + suffix + ".json"));
  }
}

async function assetDigest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return "sha256:" + hash.digest("hex");
}

export async function uploadDesktopAssets(directory: string, tag: string, repository: string) {
  const release = record(
    JSON.parse(
      execFileSync("gh", ["release", "view", tag, "--repo", repository, "--json", "assets"], {
        encoding: "utf8",
      }),
    ),
  );
  if (!Array.isArray(release.assets)) throw new Error("Invalid desktop release inventory.");
  const local: DesktopReleaseAsset[] = [];
  const existing: DesktopReleaseAsset[] = [];
  const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-existing-"));
  try {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const information = await stat(path);
      if (!information.isFile()) continue;
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Invalid desktop release asset name.");
      local.push({ name, size: information.size, digest: await assetDigest(path) });
      const previous = release.assets.find((value) => record(value).name === name);
      if (!previous) continue;
      const asset = record(previous);
      if (typeof asset.size !== "number") throw new Error("Invalid desktop release asset size.");
      let digest = typeof asset.digest === "string" ? asset.digest : "";
      if (!digest.startsWith("sha256:")) {
        execFileSync(
          "gh",
          ["release", "download", tag, "--repo", repository, "--pattern", name, "--dir", temporary],
          { stdio: "inherit" },
        );
        digest = await assetDigest(join(temporary, name));
      }
      existing.push({ name, size: asset.size, digest });
    }
    const plan = planDesktopAssetUploads(local, existing);
    if (plan.upload.length)
      execFileSync(
        "gh",
        [
          "release",
          "upload",
          tag,
          "--repo",
          repository,
          ...plan.upload.map((name) => join(directory, name)),
        ],
        { stdio: "inherit" },
      );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function createDesktopUpdateFeed(input: {
  readonly directory: string;
  readonly version: string;
  readonly clientCommit: string;
}): Promise<ClientUpdateFeed> {
  if (!isBackendVersion(input.version) || !/^[a-f0-9]{40}$/.test(input.clientCommit))
    throw new Error("A stable desktop version and exact source commit are required.");
  const artifacts: unknown[] = [];
  for (const flavor of clientUpdateFlavors) {
    for (const target of clientUpdateTargets) {
      const metadata = record(
        JSON.parse(
          await readFile(join(input.directory, `UPDATE-${flavor}-${target}.json`), "utf8"),
        ),
      );
      const build = record(
        JSON.parse(await readFile(join(input.directory, `BUILD-${flavor}-${target}.json`), "utf8")),
      );
      if (
        metadata.schema !== 1 ||
        metadata.version !== input.version ||
        metadata.sourceDirty !== false ||
        metadata.clientCommit !== input.clientCommit ||
        metadata.flavor !== flavor ||
        `${metadata.platform}-${metadata.architecture}` !== target ||
        build.version !== input.version ||
        build.clientCommit !== input.clientCommit ||
        build.sourceDirty !== false ||
        build.flavor !== flavor ||
        `${build.platform}-${build.architecture}` !== target ||
        build.coxVersion !== metadata.backendVersion ||
        build.unpacked !== false ||
        (metadata.platform === "darwin" &&
          metadata.installMode === "automatic" &&
          (metadata.macUpdateProtocol !== 1 ||
            build.macUpdateProtocol !== 1 ||
            build.clientAutomaticUpdates !== true)) ||
        (metadata.platform === "win32" &&
          metadata.installMode === "automatic" &&
          (build.clientAutomaticUpdates !== true ||
            typeof build.clientPublisherName !== "string" ||
            !build.clientPublisherName))
      )
        throw new Error("Desktop update metadata does not match the tested build.");
      artifacts.push({
        platform: metadata.platform,
        architecture: metadata.architecture,
        flavor,
        backendVersion: metadata.backendVersion,
        filename: metadata.filename,
        url: `https://github.com/doublepi123/cox/releases/download/desktop-v${input.version}/${metadata.filename}`,
        size: metadata.size,
        sha256: metadata.sha256,
        sha512: metadata.sha512,
        installMode: metadata.installMode,
        ...(metadata.macUpdateProtocol === 1 ? { macUpdateProtocol: 1 } : {}),
      });
    }
  }
  const feed = parseClientUpdateFeed({
    schema: 1,
    version: input.version,
    tag: "desktop-v" + input.version,
    artifacts,
  });
  for (const artifact of feed.artifacts) {
    const contents = await readFile(join(input.directory, artifact.filename));
    if (
      contents.length !== artifact.size ||
      createHash("sha256").update(contents).digest("hex") !== artifact.sha256 ||
      createHash("sha512").update(contents).digest("base64") !== artifact.sha512
    )
      throw new Error("The published desktop installer does not match its tested update metadata.");
    const checksum = (
      await readFile(join(input.directory, artifact.filename + ".sha256"), "utf8")
    ).trim();
    if (checksum !== `${artifact.sha256}  ${artifact.filename}`)
      throw new Error("The desktop installer checksum sidecar does not match.");
  }
  return feed;
}

async function main() {
  if (process.argv[2] === "--version-metadata") {
    await versionDesktopMetadata(resolve(process.argv[3] ?? "."));
    return;
  }
  if (process.argv[2] === "--upload") {
    const tag = process.env.RELEASE_TAG;
    const repository = process.env.GITHUB_REPOSITORY;
    if (
      !tag ||
      !/^(?:desktop-)?v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag) ||
      repository !== "doublepi123/cox"
    )
      throw new Error("An official stable Cox release is required.");
    await uploadDesktopAssets(resolve(process.argv[3] ?? "."), tag, repository);
    return;
  }
  const version = process.env.CLIENT_VERSION;
  const clientCommit = process.env.CLIENT_COMMIT;
  if (!version || !clientCommit) throw new Error("CLIENT_VERSION and CLIENT_COMMIT are required.");
  const directory = resolve(process.argv[2] ?? ".");
  const feed = await createDesktopUpdateFeed({ directory, version, clientCommit });
  await writeFile(
    join(directory, `desktop-update-${feed.version}.json`),
    JSON.stringify(feed, null, 2) + "\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
