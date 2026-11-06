import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compareBackendVersions, isBackendVersion, record } from "../src/backend-install.ts";
import {
  fetchClientUpdateFeed,
  parseClientUpdateFeed,
  type ClientUpdateFeed,
} from "../src/client-updates.ts";
import { latestDesktopTag } from "./release-plan.ts";

export const desktopLatestTag = "cox-desktop-latest";
const repository = "doublepi123/cox";
type GitHubApi = (
  path: string,
  method?: "GET" | "POST" | "PATCH",
  body?: Readonly<Record<string, unknown>>,
) => Promise<unknown>;

export function desktopLatestNotes(value: unknown): string {
  const release = record(value);
  const tag = release.tag_name;
  const version = typeof tag === "string" && tag.startsWith("desktop-v") ? tag.slice(9) : "";
  if (!isBackendVersion(version) || release.draft || release.prerelease)
    throw new Error("A published stable desktop release is required.");
  if (!Array.isArray(release.assets)) throw new Error("Desktop release assets are required.");
  const names = release.assets.map((value) => {
    const asset = record(value);
    if (typeof asset.name !== "string" || typeof asset.size !== "number" || asset.size <= 0)
      throw new Error("Invalid desktop release asset.");
    return asset.name;
  });
  const prefix = `cox-desktop-${version}-cox-`;
  const backendVersions = names
    .filter((name) => name.startsWith(prefix) && name.endsWith("-mac-arm64.dmg"))
    .map((name) => name.slice(prefix.length, -"-mac-arm64.dmg".length))
    .filter(isBackendVersion)
    .sort((left, right) => compareBackendVersions(right, left));
  const backend = backendVersions[0];
  if (!backend) throw new Error("Bundled desktop installers are required.");
  const download = (name: string) => {
    if (!names.includes(name)) throw new Error("Missing desktop release asset: " + name);
    return `https://github.com/${repository}/releases/download/${tag}/${name}`;
  };
  const lines = [
    "# Cox Desktop — latest stable / 最新稳定版",
    "",
    `Client / 客户端: **${version}** · Bundled Cox / 内置后端: **${backend}**`,
    "",
    `Versioned release / 版本发布: https://github.com/${repository}/releases/tag/${tag}`,
    "",
    "This rolling tag follows the latest stable desktop release. Downloads below belong to the versioned release; installers are not duplicated.",
    "此滚动标签始终指向最新稳定客户端。以下下载链接指向对应版本的原始安装包，不重复上传。",
    "",
    "| Platform / 平台 | Bundled Cox / 含后端 | Client only / 首次启动安装后端 |",
    "| --- | --- | --- |",
  ];
  const clientOnly = names.some((name) => name.startsWith(`cox-desktop-${version}-client-only-`));
  for (const [platform, suffix] of [
    ["macOS Apple Silicon", "mac-arm64.dmg"],
    ["macOS Intel", "mac-x64.dmg"],
    ["Windows x64", "win-x64.exe"],
  ]) {
    const bundled = `cox-desktop-${version}-cox-${backend}-${suffix}`;
    const client = `cox-desktop-${version}-client-only-${suffix}`;
    const link = (name: string) =>
      `[Download / 下载](${download(name)}) · [SHA256](${download(name + ".sha256")})`;
    lines.push(`| ${platform} | ${link(bundled)} | ${clientOnly ? link(client) : "—"} |`);
  }
  const checksums = `DESKTOP-SHA256SUMS-client-${version}-cox-${backend}.txt`;
  lines.push(
    "",
    `[All checksums / 完整校验清单](${download(checksums)})`,
    "",
    "Client-only packages install Cox from the official npm registry on first launch. Agent accounts and model subscriptions are configured separately.",
    "客户端精简包会在首次启动时从官方 npm 源安装 Cox。智能体账号及模型订阅需另行配置。",
    "",
    "Signing, notarization and platform acceptance limitations are documented in the versioned release and desktop README; this alias does not change them.",
    "签名、公证及平台验收限制以版本发布和桌面版 README 为准；滚动入口不改变这些限制。",
  );
  return lines.join("\n") + "\n";
}

export interface SyncDesktopLatestOptions {
  readonly readFeed: (url: string) => Promise<unknown>;
  readonly publishFeed: (feed: ClientUpdateFeed) => Promise<void>;
}

export async function syncDesktopLatest(
  api: GitHubApi,
  options: SyncDesktopLatestOptions,
): Promise<string> {
  const releases: unknown[] = [];
  for (let page = 1; ; page++) {
    const result = await api(`releases?per_page=100&page=${page}`);
    if (!Array.isArray(result)) throw new Error("Invalid GitHub releases response.");
    releases.push(...result);
    if (result.length < 100) break;
  }
  const tag = latestDesktopTag(releases);
  const source = await api(`releases/tags/${tag}`);
  const body = desktopLatestNotes(source);
  const version = tag.slice(9);
  const assets = record(source).assets as unknown[];
  const feedName = `desktop-update-${version}.json`;
  if (!assets.some((asset) => record(asset).name === feedName))
    throw new Error("The desktop release is missing its complete update feed.");
  const feed = parseClientUpdateFeed(
    await options.readFeed(`https://github.com/${repository}/releases/download/${tag}/${feedName}`),
  );
  if (feed.tag !== tag) throw new Error("The desktop update feed belongs to a different release.");
  for (const artifact of feed.artifacts) {
    const asset = assets.find((value) => record(value).name === artifact.filename);
    if (
      !asset ||
      record(asset).size !== artifact.size ||
      (record(asset).digest != null && record(asset).digest !== "sha256:" + artifact.sha256)
    )
      throw new Error("The desktop update feed does not match the published target set.");
  }
  const commit = record(await api(`commits/${tag}`)).sha;
  if (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Invalid desktop source commit.");
  const existing = await api(`releases/tags/${desktopLatestTag}`);
  if (existing !== null) {
    const previous = record(existing);
    const previousVersion =
      typeof previous.body === "string"
        ? previous.body.match(/releases\/tag\/desktop-v([0-9]+\.[0-9]+\.[0-9]+)/)?.[1]
        : undefined;
    if (previousVersion && compareBackendVersions(version, previousVersion) < 0)
      throw new Error("Refusing to roll the desktop update feed back to an older version.");
    if (
      Array.isArray(previous.assets) &&
      previous.assets.some((asset) => record(asset).name === "desktop-update.json")
    ) {
      const previousFeed = parseClientUpdateFeed(
        await options.readFeed(
          `https://github.com/${repository}/releases/download/${desktopLatestTag}/desktop-update.json`,
        ),
      );
      if (compareBackendVersions(version, previousFeed.version) < 0)
        throw new Error("Refusing to roll the desktop update feed back to an older version.");
    }
  }
  const reference = await api(`git/ref/tags/${desktopLatestTag}`);
  if (reference === null) {
    await api("git/refs", "POST", { ref: `refs/tags/${desktopLatestTag}`, sha: commit });
  } else {
    await api(`git/refs/tags/${desktopLatestTag}`, "PATCH", { sha: commit, force: true });
  }
  const release = {
    tag_name: desktopLatestTag,
    target_commitish: commit,
    name: "Cox Desktop — latest stable",
    body,
    draft: false,
    prerelease: false,
    make_latest: "false",
  };
  if (existing === null) {
    await api("releases", "POST", release);
  } else {
    const id = record(existing).id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
      throw new Error("Invalid rolling desktop release ID.");
    await api(`releases/${id}`, "PATCH", release);
  }
  await options.publishFeed(feed);
  return tag;
}

async function main() {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error("GitHub authentication is required to sync desktop releases.");
  const tag = await syncDesktopLatest(
    async (path, method = "GET", body) => {
      const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 404 && method === "GET" && !path.includes("?")) return null;
      if (!response.ok) throw new Error(`GitHub ${method} ${path} failed: HTTP ${response.status}`);
      return response.json() as Promise<unknown>;
    },
    {
      readFeed: (url) => fetchClientUpdateFeed(url, AbortSignal.timeout(30_000)),
      publishFeed: async (feed) => {
        const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-feed-"));
        try {
          const path = join(temporary, "desktop-update.json");
          await writeFile(path, JSON.stringify(feed, null, 2) + "\n");
          execFileSync(
            "gh",
            ["release", "upload", desktopLatestTag, "--repo", repository, "--clobber", path],
            { stdio: "inherit" },
          );
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      },
    },
  );
  console.log(`${desktopLatestTag} -> ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
