// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { DesktopUpdateProgress } from "@t3tools/contracts";
import { localServiceNodePath, runLocalServiceCommand } from "./process.ts";
import { updateEnvironment } from "./ownership.ts";

const PACKAGE = "@doublepi123/cox";
const REGISTRY = "https://registry.npmjs.org";
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

export function isBackendVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    STABLE_VERSION.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  );
}

export interface LocalServiceRelease {
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Cox release metadata.");
  return value as Record<string, unknown>;
}

export function parseLocalServiceRelease(value: unknown): LocalServiceRelease {
  const metadata = object(value);
  const dist = object(metadata.dist);
  const url = `${REGISTRY}/@doublepi123/cox/-/cox-${String(metadata.version)}.tgz`;
  if (
    metadata.name !== PACKAGE ||
    !isBackendVersion(metadata.version) ||
    dist.tarball !== url ||
    typeof dist.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)
  )
    throw new Error("The Cox update is not a verified stable official package.");
  return { version: metadata.version, url, integrity: dist.integrity };
}

async function responseBytes(
  response: Response,
  maximum: number,
  signal: AbortSignal,
  onProgress?: (progress: DesktopUpdateProgress) => void,
): Promise<Buffer> {
  if (!response.ok || !response.body)
    throw new Error("Cox update download failed: HTTP " + response.status);
  const reader = response.body.getReader();
  const declared = Number(response.headers.get("content-length"));
  const totalBytes = Number.isSafeInteger(declared) && declared > 0 ? declared : null;
  const started = performance.now();
  let transferred = 0;
  let reported = -Infinity;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      transferred += chunk.value.length;
      if (transferred > maximum) throw new Error("The Cox update exceeds its size limit.");
      chunks.push(chunk.value);
      const now = performance.now();
      if (onProgress && (now - reported >= 100 || transferred === totalBytes)) {
        reported = now;
        const rate = now > started ? transferred / ((now - started) / 1000) : null;
        onProgress({
          phase: "downloading",
          transferredBytes: transferred,
          totalBytes,
          bytesPerSecond: rate,
          remainingSeconds:
            rate && totalBytes ? Math.ceil(Math.max(0, totalBytes - transferred) / rate) : null,
        });
      }
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function fetchLocalServiceRelease(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<LocalServiceRelease> {
  const response = await fetcher(`${REGISTRY}/@doublepi123%2fcox/latest`, {
    redirect: "error",
    signal,
    headers: { "Cache-Control": "no-cache" },
  });
  return parseLocalServiceRelease(
    JSON.parse((await responseBytes(response, 1024 * 1024, signal)).toString("utf8")),
  );
}

export async function downloadLocalServiceRelease(
  release: LocalServiceRelease,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  onProgress?: (progress: DesktopUpdateProgress) => void,
): Promise<Buffer> {
  if (
    parseLocalServiceRelease({
      name: PACKAGE,
      version: release.version,
      dist: { tarball: release.url, integrity: release.integrity },
    }).url !== release.url
  )
    throw new Error("The Cox update must use the official package registry.");
  const response = await fetcher(release.url, {
    redirect: "error",
    signal,
    headers: { "Cache-Control": "no-cache" },
  });
  const bytes = await responseBytes(response, 256 * 1024 * 1024, signal, onProgress);
  onProgress?.({
    phase: "verifying",
    transferredBytes: bytes.length,
    totalBytes: bytes.length,
    bytesPerSecond: null,
    remainingSeconds: null,
  });
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== release.integrity)
    throw new Error("The Cox update SHA-512 checksum does not match.");
  return bytes;
}

export async function installLocalServiceRelease(input: {
  readonly release: LocalServiceRelease;
  readonly directory: string;
  readonly node: string;
  readonly npm: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly fetcher?: typeof fetch;
  readonly onProgress?: (progress: DesktopUpdateProgress) => void;
}): Promise<string> {
  const signal = AbortSignal.timeout(15 * 60_000);
  const bytes = await downloadLocalServiceRelease(
    input.release,
    signal,
    input.fetcher,
    input.onProgress,
  );
  input.onProgress?.({
    phase: "installing",
    transferredBytes: 0,
    totalBytes: null,
    bytesPerSecond: null,
    remainingSeconds: null,
  });
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const archive = join(input.directory, "cox.tgz");
  await writeFile(archive, bytes, { mode: 0o600, flag: "wx" });
  const config = join(input.directory, "npmrc");
  await writeFile(config, `registry=${REGISTRY}/\n`, { mode: 0o600 });
  await writeFile(join(input.directory, "package.json"), JSON.stringify({ private: true }));
  const environment = updateEnvironment(input.environment);
  environment.NPM_CONFIG_USERCONFIG = config;
  environment.NPM_CONFIG_GLOBALCONFIG = join(input.directory, "global-npmrc");
  environment.NPM_CONFIG_CACHE = join(input.directory, "npm-cache");
  environment.PATH = localServiceNodePath(input.node, environment);
  const options = { cwd: input.directory, env: environment, signal };
  await runLocalServiceCommand(
    input.node,
    [
      input.npm,
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      `--registry=${REGISTRY}`,
      archive,
    ],
    options,
  );
  const server = join(input.directory, "node_modules", "@doublepi123", "cox");
  const manifest = object(JSON.parse(await readFile(join(server, "package.json"), "utf8")));
  if (manifest.name !== PACKAGE || manifest.version !== input.release.version)
    throw new Error("The installed Cox package does not match the checked update.");
  await runLocalServiceCommand(input.node, [join(server, "postinstall.mjs")], options);
  await runLocalServiceCommand(
    input.node,
    [input.npm, "rebuild", "node-pty", "--ignore-scripts=false", "--no-audit", "--no-fund"],
    options,
  );
  await runLocalServiceCommand(
    input.node,
    [
      "--input-type=module",
      "--eval",
      `import { createRequire } from "node:module"; const require = createRequire(${JSON.stringify(join(server, "package.json"))}); require("node-pty"); require("@napi-rs/keyring");`,
    ],
    options,
  );
  for (const path of [
    "dist/bin.mjs",
    "dist/client/index.html",
    "dist/localServiceUpdate/activation.mjs",
    "dist/persistence/databaseMigrationHead.mjs",
  ])
    if (!(await stat(join(server, path))).isFile())
      throw new Error("The Cox update is incomplete.");
  await runLocalServiceCommand(input.node, [join(server, "dist", "bin.mjs"), "--version"], options);
  const current = join(input.directory, "current");
  await rm(current, { recursive: true, force: true });
  await rename(server, current);
  await rename(join(input.directory, "node_modules"), join(current, "node_modules"));
  for (const file of ["cox.tgz", "npm-cache", "npmrc", "global-npmrc", "package.json"])
    await rm(join(input.directory, file), { recursive: true, force: true });
  return join(current, "dist", "bin.mjs");
}
