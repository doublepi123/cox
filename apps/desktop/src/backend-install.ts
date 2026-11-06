import { spawn, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rename, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { pruneBackendPayload } from "./package-payload.ts";

const PACKAGE = "@doublepi123/cox";
const REGISTRY = "https://registry.npmjs.org";
const STABLE_VERSION = /^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)$/;

export function isBackendVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    STABLE_VERSION.test(value) &&
    value.length < 64 &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)))
  );
}

export function compareBackendVersions(left: string, right: string): number {
  if (!isBackendVersion(left) || !isBackendVersion(right)) throw new Error("Invalid Cox version.");
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (const index of [0, 1, 2]) {
    const difference = leftParts[index]! - rightParts[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid Cox update metadata.");
  return value as Record<string, unknown>;
}

export interface BackendRelease {
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
  readonly compatible: boolean;
  readonly nodeVersion: string | null;
}

export function backendInstallerEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP|TMPDIR|SHELL|LANG|LC_[A-Z_]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|CC|CXX|AR|PYTHON|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS)$/i;
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => allowed.test(name)));
}

export function parseBackendRelease(value: unknown, nodeVersion: string): BackendRelease {
  const metadata = record(value);
  const dist = record(metadata.dist);
  if (
    metadata.name !== PACKAGE ||
    !isBackendVersion(metadata.version) ||
    dist.tarball !== REGISTRY + "/@doublepi123/cox/-/cox-" + metadata.version + ".tgz" ||
    typeof dist.integrity !== "string" ||
    !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity)
  )
    throw new Error("The Cox update does not identify a verified stable package.");
  const compatibility = metadata.coxDesktop === undefined ? {} : record(metadata.coxDesktop);
  const requiredNode = compatibility.nodeVersion;
  const legacy =
    metadata.coxDesktop === undefined &&
    ["0.1.40", "0.1.41"].includes(metadata.version) &&
    nodeVersion.split(".")[0] === "26";
  const compatible =
    legacy ||
    (compatibility.protocol === 1 &&
      isBackendVersion(requiredNode) &&
      nodeVersion.split(".")[0] === requiredNode.split(".")[0] &&
      compareBackendVersions(nodeVersion, requiredNode) >= 0);
  return {
    version: metadata.version,
    url: dist.tarball,
    integrity: dist.integrity,
    compatible,
    nodeVersion: isBackendVersion(requiredNode) ? requiredNode : null,
  };
}

async function download(
  url: string,
  maximum: number,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Buffer> {
  const response = await fetcher(url, {
    signal,
    redirect: "error",
    headers: { "Cache-Control": "no-cache" },
  });
  if (!response.ok || !response.body)
    throw new Error("Cox update download failed: HTTP " + response.status);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > maximum) throw new Error("The Cox update download exceeds its size limit.");
      chunks.push(result.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function fetchBackendRelease(
  nodeVersion: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  version = "latest",
): Promise<BackendRelease> {
  if (version !== "latest" && !isBackendVersion(version))
    throw new Error("Invalid Cox release version.");
  const bytes = await download(
    REGISTRY + "/@doublepi123%2fcox/" + version,
    1024 * 1024,
    signal,
    fetcher,
  );
  return parseBackendRelease(JSON.parse(bytes.toString("utf8")), nodeVersion);
}

export async function downloadBackendRelease(
  release: BackendRelease,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Buffer> {
  if (
    !isBackendVersion(release.version) ||
    release.url !== REGISTRY + "/@doublepi123/cox/-/cox-" + release.version + ".tgz"
  )
    throw new Error("The Cox update download must come from the official registry.");
  const bytes = await download(release.url, 256 * 1024 * 1024, signal, fetcher);
  if ("sha512-" + createHash("sha512").update(bytes).digest("base64") !== release.integrity)
    throw new Error("The Cox update SHA-512 checksum does not match.");
  return bytes;
}

export async function runBackendCommand(
  node: string,
  arguments_: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<string> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(node, arguments_, {
      cwd: options.cwd,
      env: options.environment,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    const stop = () => {
      failure ??= new Error("The Cox update command was cancelled or timed out.");
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      if (process.platform === "win32") {
        execFile(
          join(options.environment.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, timeout: 5_000 },
          () => {
            if (child.exitCode === null) child.kill();
          },
        );
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    };
    const timeout = setTimeout(stop, 180_000);
    options.signal.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("Cox update command failed (" + code + "): " + output));
      else resolve(output);
    });
    if (options.signal.aborted) stop();
  });
}

export async function installBackendRelease(input: {
  readonly release: BackendRelease;
  readonly directory: string;
  readonly node: string;
  readonly npm: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly fetcher?: typeof fetch | undefined;
}): Promise<string> {
  if (!input.release.compatible)
    throw new Error("This Cox version requires a newer desktop client.");
  const bytes = await downloadBackendRelease(
    input.release,
    AbortSignal.any([input.signal, AbortSignal.timeout(120_000)]),
    input.fetcher,
  );
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  const archive = join(input.directory, "cox.tgz");
  await writeFile(archive, bytes, { mode: 0o600 });
  const config = join(input.directory, "npmrc");
  await writeFile(config, "registry=" + REGISTRY + "/\n", { mode: 0o600 });
  const globalConfig = join(input.directory, "global-npmrc");
  await writeFile(globalConfig, "", { mode: 0o600 });
  await writeFile(join(input.directory, "package.json"), JSON.stringify({ private: true }));
  const environment = backendInstallerEnvironment(input.environment);
  const pathKey = Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
  environment[pathKey] = dirname(input.node) + delimiter + (environment[pathKey] ?? "");
  environment.NPM_CONFIG_USERCONFIG = config;
  environment.NPM_CONFIG_GLOBALCONFIG = globalConfig;
  environment.NPM_CONFIG_CACHE = join(input.directory, "npm-cache");
  const options = { cwd: input.directory, environment, signal: input.signal };
  await runBackendCommand(
    input.node,
    [
      input.npm,
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--registry=" + REGISTRY,
      archive,
    ],
    options,
  );
  const server = join(input.directory, "node_modules", "@doublepi123", "cox");
  const installed: unknown = JSON.parse(await readFile(join(server, "package.json"), "utf8"));
  const manifest = record(installed);
  const compatibility = manifest.coxDesktop === undefined ? {} : record(manifest.coxDesktop);
  if (
    manifest.name !== PACKAGE ||
    manifest.version !== input.release.version ||
    (input.release.nodeVersion !== null &&
      (compatibility.protocol !== 1 || compatibility.nodeVersion !== input.release.nodeVersion))
  )
    throw new Error("The installed Cox package does not match the checked update.");
  await runBackendCommand(input.node, [join(server, "postinstall.mjs")], options);
  await runBackendCommand(
    input.node,
    [input.npm, "rebuild", "node-pty", "--ignore-scripts=false", "--no-audit", "--no-fund"],
    options,
  );
  const standalone = join(input.directory, "server");
  await rename(server, standalone);
  await rename(join(input.directory, "node_modules"), join(standalone, "node_modules"));
  for (const launcher of ["cox", "cox.cmd", "cox.ps1"])
    await rm(join(standalone, "node_modules", ".bin", launcher), { force: true });
  for (const file of ["dist/bin.mjs", "dist/client/index.html"]) {
    if (!(await stat(join(standalone, file))).isFile())
      throw new Error("The Cox update is incomplete.");
  }
  await runBackendCommand(
    input.node,
    [
      "--input-type=module",
      "-e",
      "import {createRequire} from 'node:module'; const require=createRequire(" +
        JSON.stringify(join(standalone, "package.json")) +
        "); require('node-pty'); require('@napi-rs/keyring');",
    ],
    options,
  );
  await pruneBackendPayload({
    server: standalone,
    platform: process.platform,
    architecture: process.arch,
  });
  const installedNodeVersion = (await runBackendCommand(input.node, ["--version"], options))
    .trim()
    .replace(/^v/, "");
  await writeFile(
    join(input.directory, "installed.json"),
    JSON.stringify({
      version: input.release.version,
      protocol: 1,
      nodeVersion: installedNodeVersion,
    }),
    { mode: 0o600 },
  );
  for (const file of ["cox.tgz", "npm-cache", "npmrc", "global-npmrc"])
    await rm(join(input.directory, file), { recursive: true, force: true });
  return standalone;
}

export function backendInstallationId(version: string): string {
  if (!isBackendVersion(version)) throw new Error("Invalid Cox installation version.");
  return version + "-" + randomUUID();
}
