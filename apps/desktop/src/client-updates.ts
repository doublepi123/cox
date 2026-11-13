import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopClientUpdateState, DesktopUpdateProgress } from "@t3tools/contracts";
import { compareBackendVersions, isBackendVersion, record } from "./backend-install.ts";
import type { MacUpdateAdapter } from "./mac-update.ts";

export const clientUpdateFeedUrl =
  "https://github.com/doublepi123/cox/releases/download/cox-desktop-latest/desktop-update.json";
export const clientUpdateTargets = ["darwin-arm64", "darwin-x64", "win32-x64"] as const;
export const clientUpdateFlavors = ["bundled", "client-only"] as const;

export interface ClientUpdateArtifact {
  readonly platform: "darwin" | "win32";
  readonly architecture: "arm64" | "x64";
  readonly flavor: "bundled" | "client-only";
  readonly backendVersion: string | null;
  readonly filename: string;
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
  readonly sha512: string;
  readonly installMode: "automatic" | "manual";
  readonly macUpdateProtocol?: 1;
}

export interface ClientUpdateFeed {
  readonly schema: 1;
  readonly version: string;
  readonly tag: string;
  readonly artifacts: readonly ClientUpdateArtifact[];
}

export function parseClientUpdateFeed(value: unknown): ClientUpdateFeed {
  const feed = record(value);
  if (
    feed.schema !== 1 ||
    !isBackendVersion(feed.version) ||
    feed.tag !== "desktop-v" + feed.version ||
    !Array.isArray(feed.artifacts) ||
    feed.artifacts.length !== 6
  )
    throw new Error("Invalid desktop update feed.");
  const identities = new Set<string>();
  const artifacts = feed.artifacts.map((value): ClientUpdateArtifact => {
    const artifact = record(value);
    const identity = `${artifact.platform}-${artifact.architecture}-${artifact.flavor}`;
    if (
      !clientUpdateTargets.some(
        (target) => target === `${artifact.platform}-${artifact.architecture}`,
      ) ||
      !clientUpdateFlavors.some((flavor) => flavor === artifact.flavor) ||
      identities.has(identity) ||
      (artifact.flavor === "bundled"
        ? !isBackendVersion(artifact.backendVersion)
        : artifact.backendVersion !== null) ||
      !Number.isSafeInteger(artifact.size) ||
      typeof artifact.size !== "number" ||
      artifact.size <= 0 ||
      artifact.size > 8 * 1024 ** 3 ||
      typeof artifact.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
      typeof artifact.sha512 !== "string" ||
      !/^[A-Za-z0-9+/]{86}==$/.test(artifact.sha512) ||
      !["manual", "automatic"].includes(String(artifact.installMode)) ||
      (artifact.macUpdateProtocol !== undefined &&
        (artifact.platform !== "darwin" || artifact.macUpdateProtocol !== 1)) ||
      (artifact.installMode === "automatic" &&
        artifact.platform === "darwin" &&
        artifact.macUpdateProtocol !== 1)
    )
      throw new Error("Invalid desktop update artifact.");
    const filename =
      `cox-desktop-${feed.version}-` +
      (artifact.flavor === "bundled" ? `cox-${artifact.backendVersion}` : "client-only") +
      `-${artifact.platform === "darwin" ? "mac" : "win"}-${artifact.architecture}.` +
      (artifact.platform === "darwin" ? "dmg" : "exe");
    if (
      artifact.filename !== filename ||
      artifact.url !==
        `https://github.com/doublepi123/cox/releases/download/${feed.tag}/${filename}`
    )
      throw new Error("The desktop update must use its official versioned release.");
    identities.add(identity);
    return artifact as unknown as ClientUpdateArtifact;
  });
  const backends = new Set(
    artifacts
      .filter((artifact) => artifact.flavor === "bundled")
      .map((artifact) => artifact.backendVersion),
  );
  if (identities.size !== 6 || backends.size !== 1)
    throw new Error("The desktop update requires a complete matching target set.");
  return { schema: 1, version: feed.version, tag: feed.tag as string, artifacts };
}

function approvedUrl(value: string, redirected = false): URL {
  const url = new URL(value);
  const github =
    url.hostname === "github.com" &&
    /^\/doublepi123\/cox\/releases\/download\/(?:desktop-v[0-9]+\.[0-9]+\.[0-9]+|cox-desktop-latest)\/[A-Za-z0-9._-]+$/.test(
      url.pathname,
    );
  const cdn =
    redirected &&
    [
      "release-assets.githubusercontent.com",
      "objects.githubusercontent.com",
      "github-releases.githubusercontent.com",
    ].includes(url.hostname);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (!github && !cdn)
  )
    throw new Error("Unapproved desktop update download URL.");
  return url;
}

export async function fetchClientUpdateResponse(
  address: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  let url = approvedUrl(address);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(url.href, {
      redirect: "manual",
      signal,
      headers: { "Cache-Control": "no-cache" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The desktop update redirect is missing its destination.");
      url = approvedUrl(new URL(location, url).href, true);
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Desktop update download failed: HTTP " + response.status);
    }
    return response;
  }
  throw new Error("Too many desktop update redirects.");
}

export async function fetchClientUpdateFeed(
  url: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<ClientUpdateFeed> {
  const response = await fetchClientUpdateResponse(url, signal, fetcher);
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 512 * 1024) throw new Error("The desktop update feed is too large.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  return parseClientUpdateFeed(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export interface ClientAutomaticUpdater {
  download(
    feed: ClientUpdateFeed,
    artifact: ClientUpdateArtifact,
    signal: AbortSignal,
    onProgress: (progress: DesktopUpdateProgress) => void,
  ): Promise<string>;
  apply(path: string): Promise<void>;
  close(): Promise<void>;
}

async function signedWindowsUpdater(
  directory: string,
  publisherName: string,
): Promise<ClientAutomaticUpdater> {
  const { NsisUpdater, Provider, CancellationToken } = await import("electron-updater");
  const { ElectronAppAdapter } = await import("electron-updater/out/ElectronAppAdapter.js");
  const { ElectronHttpExecutor } = await import("electron-updater/out/electronHttpExecutor.js");
  class CoxUpdateApp extends ElectronAppAdapter {
    override get baseCachePath() {
      return directory;
    }
    override get userDataPath() {
      return directory;
    }
  }
  const updater = new NsisUpdater(null, new CoxUpdateApp());
  Object.assign(updater, { httpExecutor: new ElectronHttpExecutor() });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = false;
  updater.allowDowngrade = false;
  updater.allowPrerelease = false;
  updater.disableDifferentialDownload = true;
  updater.disableWebInstaller = true;
  updater.on("error", () => {});
  updater.netSession.webRequest.onBeforeRequest((details, callback) => {
    try {
      approvedUrl(details.url, true);
      callback({ cancel: false });
    } catch {
      callback({ cancel: true });
    }
  });
  let cancellation: InstanceType<typeof CancellationToken> | undefined;
  return {
    async download(feed, artifact, signal, onProgress) {
      class PinnedProvider extends Provider<import("electron-updater").UpdateInfo> {
        constructor(
          _options: unknown,
          _updater: unknown,
          runtime: import("electron-updater/out/providers/Provider.js").ProviderRuntimeOptions,
        ) {
          super(runtime);
        }
        async getLatestVersion() {
          return {
            version: feed.version,
            releaseDate: "1970-01-01T00:00:00.000Z",
            path: artifact.filename,
            sha512: artifact.sha512,
            files: [{ url: artifact.url, sha512: artifact.sha512, size: artifact.size }],
          };
        }
        resolveFiles() {
          return [
            {
              url: new URL(artifact.url),
              info: { url: artifact.url, sha512: artifact.sha512, size: artifact.size },
            },
          ];
        }
      }
      updater.setFeedURL({ provider: "custom", updateProvider: PinnedProvider });
      const checked = await updater.checkForUpdates();
      if (!checked?.isUpdateAvailable || checked.updateInfo.version !== feed.version)
        throw new Error("The signed desktop updater rejected the selected version.");
      cancellation = new CancellationToken();
      const abort = () => cancellation?.cancel();
      signal.addEventListener("abort", abort, { once: true });
      const progress = (value: import("electron-updater").ProgressInfo) =>
        onProgress({
          phase: "downloading",
          transferredBytes: value.transferred,
          totalBytes: value.total,
          bytesPerSecond: value.bytesPerSecond,
          remainingSeconds:
            value.bytesPerSecond > 0
              ? Math.ceil((value.total - value.transferred) / value.bytesPerSecond)
              : null,
        });
      updater.on("download-progress", progress);
      try {
        signal.throwIfAborted();
        const paths = await updater.downloadUpdate(cancellation);
        const path = paths[0];
        if (!path || paths.length !== 1)
          throw new Error("The signed desktop installer is missing.");
        const error = await updater.verifyUpdateCodeSignature([publisherName], path);
        if (error) throw new Error("The desktop installer signature is invalid: " + error);
        return path;
      } finally {
        signal.removeEventListener("abort", abort);
        updater.removeListener("download-progress", progress);
        cancellation = undefined;
      }
    },
    async apply(path) {
      const error = await updater.verifyUpdateCodeSignature([publisherName], path);
      if (error) throw new Error("The desktop installer signature is invalid: " + error);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(path, ["--updated", "--force-run"], {
          detached: true,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
      });
    },
    async close() {
      cancellation?.cancel();
      updater.netSession.webRequest.onBeforeRequest(null);
      updater.removeAllListeners();
    },
  };
}

export interface ClientUpdatesOptions {
  readonly home: string;
  readonly desktopVersion: string;
  readonly platform: string;
  readonly architecture: string;
  readonly flavor: "bundled" | "client-only";
  readonly offline?: boolean;
  readonly automaticUpdates?: boolean;
  readonly publisherName?: string;
  readonly macUpdater?: MacUpdateAdapter;
  readonly onState: (state: DesktopClientUpdateState) => void;
  readonly fetcher?: typeof fetch;
  readonly now?: () => number;
  readonly openInstaller?: (path: string) => Promise<string>;
  readonly createAutomaticUpdater?: (
    directory: string,
    publisherName: string,
  ) => Promise<ClientAutomaticUpdater>;
}

export class ClientUpdates {
  private readonly options: ClientUpdatesOptions;
  private readonly directory: string;
  private readonly initialized: Promise<void>;
  private preferenceOperation = Promise.resolve();
  private operation: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private closing: Promise<void> | undefined;
  private applied = false;
  private failedMacVersion: string | undefined;
  private feed: ClientUpdateFeed | undefined;
  private artifact: ClientUpdateArtifact | undefined;
  private downloaded: string | undefined;
  private manualDownload: string | undefined;
  private installerHandedOff = false;
  private automatic: ClientAutomaticUpdater | undefined;
  private state: DesktopClientUpdateState;

  constructor(options: ClientUpdatesOptions) {
    if (!isBackendVersion(options.desktopVersion))
      throw new Error("Invalid desktop client version.");
    this.options = options;
    this.directory = join(options.home, "client-updates");
    this.state = {
      currentVersion: options.desktopVersion,
      latestVersion: null,
      status: "idle",
      progress: null,
      message: null,
      installMode: "manual",
      automaticChecks: true,
      ignoredVersion: null,
    };
    this.initialized = this.loadPreferences()
      .then(() => this.loadMacResult())
      .catch((error: unknown) => {
        this.publish({ status: "error", automaticChecks: false, message: String(error) });
      });
  }

  getState(): DesktopClientUpdateState {
    return { ...this.state, progress: this.state.progress ? { ...this.state.progress } : null };
  }

  private publish(change: Partial<DesktopClientUpdateState>) {
    if (this.closed) return;
    this.state = { ...this.state, ...change };
    this.options.onState(this.getState());
  }

  private async loadPreferences() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let contents: string;
    try {
      contents = await readFile(join(this.directory, "preferences.json"), "utf8");
    } catch (error) {
      if (record(error).code === "ENOENT") return;
      throw error;
    }
    const preferences = record(JSON.parse(contents));
    if (
      typeof preferences.automaticChecks !== "boolean" ||
      (preferences.ignoredVersion !== null && !isBackendVersion(preferences.ignoredVersion))
    )
      throw new Error("Invalid desktop client update preferences.");
    this.publish({
      automaticChecks: preferences.automaticChecks,
      ignoredVersion: preferences.ignoredVersion as string | null,
    });
  }

  private async loadMacResult() {
    if (this.options.platform !== "darwin") return;
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(this.directory, "mac-result.json"), "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const result = record(value);
    if (
      result.status === "rolled-back" &&
      result.currentVersion === this.options.desktopVersion &&
      isBackendVersion(result.version)
    ) {
      this.failedMacVersion = result.version;
      this.publish({
        status: "error",
        message: "The macOS client update failed. The previous application and data were restored.",
      });
    }
  }

  async setPolicy(
    policy: "automatic" | "ignore-version" | "never",
    version?: string,
  ): Promise<DesktopClientUpdateState> {
    if (
      !["automatic", "ignore-version", "never"].includes(policy) ||
      (policy === "ignore-version" && !isBackendVersion(version))
    )
      throw new Error("Invalid desktop client update policy.");
    await this.initialized;
    if (this.closed) return this.getState();
    const operation = this.preferenceOperation.then(async () => {
      const preferences = {
        automaticChecks:
          policy === "ignore-version" ? this.state.automaticChecks : policy === "automatic",
        ignoredVersion: policy === "ignore-version" ? version! : null,
      };
      const temporary = join(this.directory, "preferences-" + randomUUID() + ".json");
      try {
        await writeFile(temporary, JSON.stringify(preferences), { mode: 0o600, flag: "wx" });
        await rename(temporary, join(this.directory, "preferences.json"));
      } finally {
        await rm(temporary, { force: true });
      }
      const dismiss =
        this.state.status === "available" &&
        (policy === "never" || preferences.ignoredVersion === this.state.latestVersion);
      this.publish({ ...preferences, ...(dismiss ? { status: "idle", message: null } : {}) });
    });
    this.preferenceOperation = operation.catch(() => {});
    await operation;
    return this.getState();
  }

  async check(manual = false): Promise<DesktopClientUpdateState> {
    await this.initialized;
    await this.preferenceOperation;
    if (this.operation) {
      await this.operation;
      return this.getState();
    }
    if (this.closed || this.state.status === "ready" || (!manual && !this.state.automaticChecks))
      return this.getState();
    if (this.options.offline) {
      if (manual)
        this.publish({
          status: "error",
          message: "Desktop update checks are unavailable offline.",
          progress: null,
        });
      return this.getState();
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    this.publish({ status: "checking", message: null, progress: null });
    this.operation = (async () => {
      try {
        const feed = await fetchClientUpdateFeed(clientUpdateFeedUrl, signal, this.options.fetcher);
        signal.throwIfAborted();
        const artifact = feed.artifacts.find(
          (candidate) =>
            candidate.platform === this.options.platform &&
            candidate.architecture === this.options.architecture &&
            candidate.flavor === this.options.flavor,
        );
        if (!artifact)
          throw new Error("No desktop update is available for this platform and package flavor.");
        this.feed = feed;
        this.artifact = artifact;
        const newer = compareBackendVersions(feed.version, this.options.desktopVersion) > 0;
        const ignored =
          !manual && (!this.state.automaticChecks || this.state.ignoredVersion === feed.version);
        const failed = !manual && feed.version === this.failedMacVersion;
        this.publish({
          latestVersion: feed.version,
          status: failed ? "error" : newer && !ignored ? "available" : "idle",
          installMode:
            artifact.installMode === "automatic" &&
            this.options.automaticUpdates === true &&
            ((this.options.platform === "win32" && !!this.options.publisherName) ||
              (this.options.platform === "darwin" &&
                artifact.macUpdateProtocol === 1 &&
                !!this.options.macUpdater))
              ? "automatic"
              : "manual",
          message: failed
            ? "The macOS client update failed. The previous application and data were restored."
            : null,
        });
      } catch (error) {
        this.publish({ status: "error", message: String(error), progress: null });
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
    return this.getState();
  }

  private async verify(path: string, artifact: ClientUpdateArtifact, signal: AbortSignal) {
    this.publish({
      progress: {
        phase: "verifying",
        transferredBytes: artifact.size,
        totalBytes: artifact.size,
        bytesPerSecond: null,
        remainingSeconds: null,
      },
    });
    const information = await lstat(path);
    if (!information.isFile() || information.size !== artifact.size)
      throw new Error("The desktop installer size does not match.");
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    for await (const chunk of createReadStream(path, { signal })) {
      sha256.update(chunk);
      sha512.update(chunk);
    }
    if (sha256.digest("hex") !== artifact.sha256 || sha512.digest("base64") !== artifact.sha512)
      throw new Error("The desktop installer checksum does not match.");
  }

  private async downloadManual(
    artifact: ClientUpdateArtifact,
    signal: AbortSignal,
  ): Promise<string> {
    const directory = join(this.directory, "downloads", randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.manualDownload = directory;
    const path = join(directory, artifact.filename);
    try {
      const response = await fetchClientUpdateResponse(artifact.url, signal, this.options.fetcher);
      const length = response.headers.get("content-length");
      if (length !== null && Number(length) !== artifact.size) {
        await response.body!.cancel();
        throw new Error("The desktop installer size does not match.");
      }
      const file = await open(path, "wx", 0o600);
      const reader = response.body!.getReader();
      const now = this.options.now ?? Date.now;
      const started = now();
      let transferred = 0;
      let lastReported = -Infinity;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          transferred += chunk.value.length;
          if (transferred > artifact.size)
            throw new Error("The desktop installer exceeds its expected size.");
          await file.writeFile(chunk.value);
          const current = now();
          if (current - lastReported < 100 && transferred !== artifact.size) continue;
          lastReported = current;
          const elapsed = (current - started) / 1000;
          const rate = elapsed > 0 ? transferred / elapsed : null;
          this.publish({
            progress: {
              phase: "downloading",
              transferredBytes: transferred,
              totalBytes: artifact.size,
              bytesPerSecond: rate,
              remainingSeconds: rate ? Math.ceil((artifact.size - transferred) / rate) : null,
            },
          });
        }
      } finally {
        try {
          await reader.cancel();
        } finally {
          await file.close();
        }
      }
      return path;
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      if (this.manualDownload === directory) this.manualDownload = undefined;
      throw error;
    }
  }

  async download(): Promise<DesktopClientUpdateState> {
    await this.initialized;
    if (this.operation) {
      await this.operation;
      return this.getState();
    }
    const { feed, artifact } = this;
    if (
      this.closed ||
      !["available", "error"].includes(this.state.status) ||
      !feed ||
      !artifact ||
      compareBackendVersions(feed.version, this.options.desktopVersion) <= 0
    )
      return this.getState();
    if (this.options.offline) {
      this.publish({
        status: "error",
        message: "Desktop updates cannot be downloaded offline.",
        progress: null,
      });
      return this.getState();
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(15 * 60_000)]);
    this.publish({
      status: "downloading",
      message: null,
      progress: {
        phase: "downloading",
        transferredBytes: 0,
        totalBytes: artifact.size,
        bytesPerSecond: null,
        remainingSeconds: null,
      },
    });
    this.operation = (async () => {
      let path: string | undefined;
      try {
        if (this.state.installMode === "automatic" && this.options.platform === "win32") {
          this.automatic ??= await (this.options.createAutomaticUpdater ?? signedWindowsUpdater)(
            this.directory,
            this.options.publisherName!,
          );
          path = await this.automatic.download(feed, artifact, signal, (progress) =>
            this.publish({ progress }),
          );
        } else path = await this.downloadManual(artifact, signal);
        await this.verify(path, artifact, signal);
        if (this.state.installMode === "automatic" && this.options.platform === "darwin") {
          this.publish({
            progress: {
              phase: "validating",
              transferredBytes: artifact.size,
              totalBytes: artifact.size,
              bytesPerSecond: null,
              remainingSeconds: null,
            },
          });
          await this.options.macUpdater!.prepare(path, {
            version: feed.version,
            architecture: artifact.architecture,
            flavor: artifact.flavor,
            backendVersion: artifact.backendVersion,
          });
        }
        signal.throwIfAborted();
        this.downloaded = path;
        this.publish({ status: "ready", progress: null, message: null });
      } catch (error) {
        if (path) await rm(path, { force: true }).catch(() => {});
        this.publish({ status: "error", progress: null, message: String(error) });
      }
    })();
    try {
      await this.operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
    return this.getState();
  }

  async apply(): Promise<void> {
    if (this.operation) await this.operation;
    const { downloaded, artifact, feed } = this;
    if (
      this.closed ||
      this.applied ||
      this.state.status !== "ready" ||
      !downloaded ||
      !artifact ||
      !feed ||
      compareBackendVersions(feed.version, this.options.desktopVersion) <= 0
    )
      throw new Error("A verified desktop update must be downloaded before installing.");
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const operation = (async () => {
      try {
        await this.verify(downloaded, artifact, signal);
        signal.throwIfAborted();
        this.publish({
          progress: {
            phase: "installing",
            transferredBytes: artifact.size,
            totalBytes: artifact.size,
            bytesPerSecond: null,
            remainingSeconds: null,
          },
        });
        if (this.state.installMode === "automatic" && this.options.platform === "darwin")
          await this.options.macUpdater!.apply();
        else if (this.state.installMode === "automatic" && this.automatic)
          await this.automatic.apply(downloaded);
        else {
          const openInstaller =
            this.options.openInstaller ??
            (async (path: string) => (await import("electron")).shell.openPath(path));
          const error = await openInstaller(downloaded);
          if (error) throw new Error("The desktop installer could not be opened: " + error);
          this.installerHandedOff = true;
        }
        this.applied = true;
        this.publish({ progress: null });
      } catch (error) {
        this.publish({ status: "error", message: String(error), progress: null });
        throw error;
      }
    })();
    this.operation = operation;
    try {
      await operation;
    } finally {
      this.operation = undefined;
      this.controller = undefined;
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.controller?.abort();
    this.closing = (async () => {
      await this.initialized;
      await this.operation?.catch(() => {});
      await this.preferenceOperation;
      const results = await Promise.allSettled([
        this.automatic?.close(),
        this.options.macUpdater?.close(),
      ]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
      const manualDownload = this.manualDownload;
      if (manualDownload && !this.installerHandedOff) {
        this.manualDownload = undefined;
        await rm(manualDownload, { recursive: true, force: true }).catch(() => {});
      }
    })();
    return this.closing;
  }
}
