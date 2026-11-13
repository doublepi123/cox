import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DesktopClientUpdateState } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ClientUpdates,
  clientUpdateFeedUrl,
  fetchClientUpdateFeed,
  fetchClientUpdateResponse,
  parseClientUpdateFeed,
  type ClientUpdateFeed,
  type ClientUpdatesOptions,
} from "./client-updates.ts";

const bytes = Buffer.from("verified desktop installer");
function feed(version = "0.3.0", automatic = false): ClientUpdateFeed {
  return {
    schema: 1,
    version,
    tag: "desktop-v" + version,
    artifacts: ["darwin-arm64", "darwin-x64", "win32-x64"].flatMap((target) => {
      const [platform, architecture] = target.split("-") as ["darwin" | "win32", "arm64" | "x64"];
      return (["bundled", "client-only"] as const).map((flavor) => {
        const filename = `cox-desktop-${version}-${flavor === "bundled" ? "cox-0.1.44" : flavor}-${platform === "darwin" ? "mac" : "win"}-${architecture}.${platform === "darwin" ? "dmg" : "exe"}`;
        return {
          platform,
          architecture,
          flavor,
          backendVersion: flavor === "bundled" ? "0.1.44" : null,
          filename,
          url: `https://github.com/doublepi123/cox/releases/download/desktop-v${version}/${filename}`,
          size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          sha512: createHash("sha512").update(bytes).digest("base64"),
          installMode:
            automatic && platform === "win32" ? ("automatic" as const) : ("manual" as const),
        };
      });
    }),
  };
}

const directories: string[] = [];
const clients: ClientUpdates[] = [];
async function fixture(overrides: Partial<ClientUpdatesOptions> = {}, release = feed()) {
  const home = await mkdtemp(join(tmpdir(), "cox-client-updates-"));
  directories.push(home);
  const states: DesktopClientUpdateState[] = [];
  const openInstaller = vi.fn<(path: string) => Promise<string>>(async () => "");
  const fetcher = vi.fn<typeof fetch>(async (address) =>
    String(address) === clientUpdateFeedUrl ? Response.json(release) : new Response(bytes),
  );
  const options: ClientUpdatesOptions = {
    home,
    desktopVersion: "0.2.4",
    platform: "darwin",
    architecture: "arm64",
    flavor: "bundled",
    onState: (state) => states.push(state),
    fetcher,
    openInstaller,
    ...overrides,
  };
  const updates = new ClientUpdates(options);
  clients.push(updates);
  return { updates, options, home, states, fetcher, openInstaller };
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((updates) => updates.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("desktop client release feed security", () => {
  it("requires all six unique platform, architecture and flavor identities", () => {
    expect(parseClientUpdateFeed(feed()).artifacts).toHaveLength(6);
    const release = feed();
    for (const invalid of [
      { ...release, artifacts: release.artifacts.slice(1) },
      { ...release, artifacts: release.artifacts.map(() => release.artifacts[0]) },
      { ...release, tag: "v0.3.0" },
      { ...release, version: "0.3.0-beta.1" },
      { ...release, schema: 2 },
    ])
      expect(() => parseClientUpdateFeed(invalid)).toThrow();
  });

  it.each([
    { url: "http://github.com/doublepi123/cox/releases/download/desktop-v0.3.0/file.dmg" },
    { url: "https://github.com/attacker/cox/releases/download/desktop-v0.3.0/file.dmg" },
    { url: "https://example.com/installer.dmg" },
    { filename: "../../installer.dmg" },
    { filename: "cox-desktop-0.3.0-client-only-mac-arm64.dmg" },
    { backendVersion: "0.1.45" },
    { sha256: "a".repeat(63) },
    { sha512: "sha512-untrusted" },
    { size: 0 },
    { size: Number.MAX_SAFE_INTEGER },
    { architecture: "x86" },
    { installMode: "automatic" },
  ])("rejects artifact metadata %j", (change) => {
    const release = feed();
    expect(() =>
      parseClientUpdateFeed({
        ...release,
        artifacts: [{ ...release.artifacts[0], ...change }, ...release.artifacts.slice(1)],
      }),
    ).toThrow();
  });

  it.each([
    "http://release-assets.githubusercontent.com/file",
    "https://github.com.evil.invalid/file",
    "https://github.com/other/cox/releases/download/desktop-v0.3.0/file.exe",
    "https://user:password@release-assets.githubusercontent.com/file",
    "https://release-assets.githubusercontent.com:444/file",
    "https://registry.npmjs.org/unrelated",
    "file:///tmp/installer",
  ])("rejects an unsafe redirect before fetching its destination: %s", async (location) => {
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(null, { status: 302, headers: { location } }),
    );
    await expect(
      fetchClientUpdateResponse(clientUpdateFeedUrl, new AbortController().signal, fetcher),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("allows HTTPS GitHub release CDN redirects and bounds redirect loops", async () => {
    const location =
      "https://release-assets.githubusercontent.com/github-production-release-asset/123?token=temporary";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }))
      .mockResolvedValueOnce(Response.json(feed()));
    expect(
      (await fetchClientUpdateFeed(clientUpdateFeedUrl, new AbortController().signal, fetcher))
        .version,
    ).toBe("0.3.0");
    expect(fetcher.mock.calls[1]?.[0]).toBe(location);
    expect(fetcher.mock.calls.every(([, options]) => options?.redirect === "manual")).toBe(true);
    fetcher
      .mockReset()
      .mockImplementation(async () => new Response(null, { status: 302, headers: { location } }));
    await expect(
      fetchClientUpdateResponse(clientUpdateFeedUrl, new AbortController().signal, fetcher),
    ).rejects.toThrow("Too many");
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("bounds metadata downloads and rejects a missing rolling feed", async () => {
    await expect(
      fetchClientUpdateFeed(
        clientUpdateFeedUrl,
        new AbortController().signal,
        async () => new Response(" ".repeat(512 * 1024 + 1)),
      ),
    ).rejects.toThrow("too large");
    await expect(
      fetchClientUpdateFeed(
        clientUpdateFeedUrl,
        new AbortController().signal,
        async () => new Response(null, { status: 404 }),
      ),
    ).rejects.toThrow("HTTP 404");
  });
});

describe("desktop client update lifecycle", () => {
  it("prepares and applies an automatic macOS DMG update without opening an installer", async () => {
    const release = feed();
    const macRelease: ClientUpdateFeed = {
      ...release,
      artifacts: release.artifacts.map((artifact) =>
        artifact.platform === "darwin"
          ? { ...artifact, installMode: "automatic", macUpdateProtocol: 1 }
          : artifact,
      ),
    };
    const macUpdater = {
      prepare: vi.fn(async () => {}),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { updates, openInstaller } = await fixture(
      { automaticUpdates: true, macUpdater },
      macRelease,
    );
    expect((await updates.check()).installMode).toBe("automatic");
    expect((await updates.download()).status).toBe("ready");
    expect(macUpdater.prepare).toHaveBeenCalledOnce();
    expect(macUpdater.apply).not.toHaveBeenCalled();
    await updates.apply();
    expect(macUpdater.apply).toHaveBeenCalledOnce();
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it("does not hand off a macOS update whose application verification fails", async () => {
    const release = feed();
    const macRelease: ClientUpdateFeed = {
      ...release,
      artifacts: release.artifacts.map((artifact) =>
        artifact.platform === "darwin"
          ? { ...artifact, installMode: "automatic", macUpdateProtocol: 1 }
          : artifact,
      ),
    };
    const macUpdater = {
      prepare: vi.fn(async () => {
        throw new Error("Invalid signature");
      }),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { updates, openInstaller } = await fixture(
      { automaticUpdates: true, macUpdater },
      macRelease,
    );
    await updates.check();
    expect((await updates.download()).status).toBe("error");
    await expect(updates.apply()).rejects.toThrow();
    expect(macUpdater.apply).not.toHaveBeenCalled();
    expect(openInstaller).not.toHaveBeenCalled();
  });
  it.each([
    "darwin-arm64-bundled",
    "darwin-x64-client-only",
    "win32-x64-bundled",
    "win32-x64-client-only",
  ])("preserves target identity for %s", async (identity) => {
    const [platform, architecture, ...parts] = identity.split("-");
    const { updates, fetcher, openInstaller } = await fixture({
      platform: platform!,
      architecture: architecture!,
      flavor: parts.join("-") as "bundled" | "client-only",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect((await updates.check()).status).toBe("available");
    expect((await updates.download()).status).toBe("ready");
    const selected = feed().artifacts.find(
      (artifact) => `${artifact.platform}-${artifact.architecture}-${artifact.flavor}` === identity,
    )!;
    expect(fetcher.mock.calls[1]?.[0]).toBe(selected.url);
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it.each(["0.2.4", "0.2.3"])("never offers equal or older version %s", async (version) => {
    const { updates, fetcher } = await fixture({}, feed(version));
    expect((await updates.check(true)).status).toBe("idle");
    await updates.download();
    await expect(updates.apply()).rejects.toThrow("must be downloaded");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports streaming throughput and verification, then opens the installer only on explicit apply", async () => {
    let clock = 0;
    const { updates, openInstaller, states } = await fixture({
      now: () => {
        clock += 1000;
        return clock;
      },
    });
    await Promise.all([updates.check(), updates.check()]);
    await updates.download();
    expect(states.some((state) => state.progress?.phase === "verifying")).toBe(true);
    expect(
      states.find(
        (state) =>
          state.progress?.transferredBytes === bytes.length &&
          state.progress.phase === "downloading",
      )?.progress,
    ).toMatchObject({
      bytesPerSecond: bytes.length,
      remainingSeconds: 0,
      totalBytes: bytes.length,
    });
    await updates.apply();
    expect(openInstaller).toHaveBeenCalledTimes(1);
    const path = openInstaller.mock.calls[0]?.[0];
    expect(await readFile(path!)).toEqual(bytes);
    await expect(updates.apply()).rejects.toThrow("must be downloaded");
    await updates.close();
    expect(openInstaller).toHaveBeenCalledTimes(1);
  });

  it("does not download a retained older release after a subsequent check fails", async () => {
    const { updates, fetcher } = await fixture({}, feed("0.2.3"));
    await updates.check();
    fetcher.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await updates.check(true)).status).toBe("error");
    await updates.download();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("limits streaming progress updates while always reporting the final bytes", async () => {
    const { updates, fetcher, states } = await fixture({ now: () => 0 });
    await updates.check();
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (let index = 0; index < bytes.length; index++)
              controller.enqueue(bytes.subarray(index, index + 1));
            controller.close();
          },
        }),
      ),
    );
    expect((await updates.download()).status).toBe("ready");
    const progress = states.filter((state) => state.progress?.phase === "downloading");
    expect(progress.length).toBeLessThanOrEqual(3);
    expect(progress.at(-1)?.progress?.transferredBytes).toBe(bytes.length);
  });

  it("persists ignore and automatic-check policies while allowing explicit checks", async () => {
    const { updates, options, fetcher } = await fixture();
    await updates.setPolicy("ignore-version", "0.3.0");
    await updates.close();
    const restored = new ClientUpdates(options);
    clients.push(restored);
    expect((await restored.check()).status).toBe("idle");
    expect((await restored.check(true)).status).toBe("available");
    await restored.setPolicy("never");
    const calls = fetcher.mock.calls.length;
    await restored.check();
    expect(fetcher).toHaveBeenCalledTimes(calls);
    expect((await restored.check(true)).status).toBe("available");
    await restored.setPolicy("automatic");
    expect(restored.getState()).toMatchObject({ automaticChecks: true, ignoredVersion: null });
    await expect(restored.setPolicy("ignore-version", "../bad")).rejects.toThrow("policy");
  });

  it("honors a policy changed during a network check", async () => {
    let resolveFeed: (response: Response) => void = () => {};
    const { updates, states } = await fixture({
      fetcher: async () =>
        new Promise((resolve) => {
          resolveFeed = resolve;
        }),
    });
    const checking = updates.check();
    await vi.waitFor(() => expect(states.at(-1)?.status).toBe("checking"));
    await updates.setPolicy("never");
    resolveFeed(Response.json(feed()));
    await checking;
    expect(updates.getState()).toMatchObject({ status: "idle", automaticChecks: false });
  });

  it("keeps current unsigned installations on manual handoff even when the new release is signed", async () => {
    const createAutomaticUpdater = vi.fn();
    const { updates, openInstaller } = await fixture(
      { platform: "win32", architecture: "x64", createAutomaticUpdater },
      feed("0.3.0", true),
    );
    expect((await updates.check()).installMode).toBe("manual");
    await updates.download();
    await updates.apply();
    expect(createAutomaticUpdater).not.toHaveBeenCalled();
    expect(openInstaller).toHaveBeenCalledTimes(1);
  });

  it("uses the signed updater only when both installed build and release opt in", async () => {
    const home = await mkdtemp(join(tmpdir(), "cox-signed-update-"));
    directories.push(home);
    const path = join(home, "verified.exe");
    const adapter = {
      download: vi.fn(async () => {
        await writeFile(path, bytes);
        return path;
      }),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { updates, openInstaller } = await fixture(
      {
        platform: "win32",
        architecture: "x64",
        automaticUpdates: true,
        publisherName: "Cox Publisher",
        createAutomaticUpdater: async () => adapter,
      },
      feed("0.3.0", true),
    );
    expect((await updates.check()).installMode).toBe("automatic");
    expect((await updates.download()).status).toBe("ready");
    await updates.apply();
    expect(adapter.apply).toHaveBeenCalledWith(path);
    expect(openInstaller).not.toHaveBeenCalled();
    await updates.close();
    expect(adapter.close).toHaveBeenCalled();
  });

  it("does not fall back to unsigned installation after a signed updater failure", async () => {
    const { updates, openInstaller } = await fixture(
      {
        platform: "win32",
        architecture: "x64",
        automaticUpdates: true,
        publisherName: "Cox Publisher",
        createAutomaticUpdater: async () => {
          throw new Error("signature check failed");
        },
      },
      feed("0.3.0", true),
    );
    await updates.check();
    expect((await updates.download()).status).toBe("error");
    expect(updates.getState().message).toContain("signature check failed");
    expect(openInstaller).not.toHaveBeenCalled();
  });

  it.each(["truncated", "oversized", "wrong checksum", "wrong content length"])(
    "rejects %s installer bytes",
    async (kind) => {
      const { updates, fetcher, home } = await fixture();
      await updates.check();
      const contents =
        kind === "truncated"
          ? bytes.subarray(0, -1)
          : kind === "oversized"
            ? Buffer.concat([bytes, bytes])
            : Buffer.alloc(bytes.length, 1);
      fetcher.mockImplementation(
        async () =>
          new Response(
            contents,
            kind === "wrong content length" ? { headers: { "content-length": "1" } } : {},
          ),
      );
      expect((await updates.download()).status).toBe("error");
      await expect(updates.apply()).rejects.toThrow();
      const folders = await readdir(join(home, "client-updates", "downloads"));
      for (const folder of folders)
        expect(await readdir(join(home, "client-updates", "downloads", folder))).toEqual([]);
    },
  );

  it("revalidates the staged file and refuses to apply after local corruption", async () => {
    const { updates, home, openInstaller } = await fixture();
    await updates.check();
    await updates.download();
    const directory = join(home, "client-updates", "downloads");
    const folder = (await readdir(directory))[0]!;
    await writeFile(
      join(directory, folder, feed().artifacts[0]!.filename),
      Buffer.alloc(bytes.length),
    );
    await expect(updates.apply()).rejects.toThrow("checksum");
    expect(openInstaller).not.toHaveBeenCalled();
    expect(updates.getState().status).toBe("error");
  });

  it("cleans an interrupted response body and permits a fresh download", async () => {
    const { updates, fetcher, home } = await fixture();
    await updates.check();
    let chunks = 0;
    fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (chunks++ === 0) controller.enqueue(bytes.subarray(0, 3));
            else controller.error(new Error("connection lost"));
          },
        }),
      ),
    );
    expect((await updates.download()).status).toBe("error");
    expect(updates.getState().message).toContain("connection lost");
    expect(await readdir(join(home, "client-updates", "downloads"))).toEqual([]);
    expect((await updates.download()).status).toBe("ready");
  });

  it("removes an unapplied manual installer on close", async () => {
    const { updates, home } = await fixture();
    await updates.check();
    await updates.download();
    const downloads = join(home, "client-updates", "downloads");
    expect(await readdir(downloads)).toHaveLength(1);
    await updates.close();
    expect(await readdir(downloads)).toEqual([]);
  });

  it("preserves a manual installer after successful handoff", async () => {
    const { updates, openInstaller } = await fixture();
    await updates.check();
    await updates.download();
    await updates.apply();
    const path = openInstaller.mock.calls[0]![0];
    await updates.close();
    expect(await readFile(path)).toEqual(bytes);
  });

  it("does not leave an abandoned installer when close races a download", async () => {
    const { updates, fetcher, home } = await fixture();
    await updates.check();
    let downloading = false;
    fetcher.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          downloading = true;
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const download = updates.download();
    await vi.waitFor(() => expect(downloading).toBe(true));
    await updates.close();
    await download;
    expect(await readdir(join(home, "client-updates", "downloads"))).toEqual([]);
  });

  it("propagates installer handoff failure so the parent can keep the app open", async () => {
    const { updates } = await fixture({ openInstaller: async () => "OS refused the installer" });
    await updates.check();
    await updates.download();
    await expect(updates.apply()).rejects.toThrow("OS refused");
    expect(updates.getState()).toMatchObject({ status: "error", progress: null });
  });

  it("does no networking offline and rejects unsupported targets", async () => {
    const { updates, fetcher } = await fixture({ offline: true });
    await updates.check();
    expect((await updates.check(true)).status).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
    const unsupported = await fixture({ platform: "linux" });
    expect((await unsupported.updates.check()).message).toContain("platform and package flavor");
  });

  it("aborts in-flight downloads on close without publishing a late ready state", async () => {
    const { updates, fetcher, states } = await fixture();
    await updates.check();
    let downloading = false;
    fetcher.mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          downloading = true;
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const download = updates.download();
    await vi.waitFor(() => expect(downloading).toBe(true));
    const calls = states.length;
    await updates.close();
    await download;
    expect(states).toHaveLength(calls);
    expect(states.some((state) => state.status === "ready")).toBe(false);
  });

  it("shares one cleanup promise across simultaneous and repeated closes", async () => {
    const macUpdater = {
      prepare: vi.fn(async () => {}),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { updates } = await fixture({ macUpdater });
    const closing = updates.close();
    expect(updates.close()).toBe(closing);
    await closing;
    expect(updates.close()).toBe(closing);
    expect(macUpdater.close).toHaveBeenCalledOnce();
  });

  it("does not rerun a rejected cleanup every time the app attempts to quit", async () => {
    const error = Object.assign(new Error("directory not empty"), { code: "ENOTEMPTY" });
    const macUpdater = {
      prepare: vi.fn(async () => {}),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {
        throw error;
      }),
    };
    const { updates } = await fixture({ macUpdater });
    clients.splice(clients.indexOf(updates), 1);
    const closing = updates.close();
    await expect(closing).rejects.toBe(error);
    expect(updates.close()).toBe(closing);
    await expect(updates.close()).rejects.toBe(error);
    expect(macUpdater.close).toHaveBeenCalledOnce();
  });

  it("waits for macOS preparation before cleanup and never publishes a late ready state", async () => {
    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const release = feed();
    const macRelease: ClientUpdateFeed = {
      ...release,
      artifacts: release.artifacts.map((artifact) =>
        artifact.platform === "darwin"
          ? { ...artifact, installMode: "automatic", macUpdateProtocol: 1 }
          : artifact,
      ),
    };
    const macUpdater = {
      prepare: vi.fn(async () => {
        await pending;
      }),
      apply: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const { updates, states } = await fixture({ automaticUpdates: true, macUpdater }, macRelease);
    await updates.check();
    const download = updates.download();
    await vi.waitFor(() => expect(macUpdater.prepare).toHaveBeenCalledOnce());
    const calls = states.length;
    const closing = updates.close();
    await Promise.resolve();
    expect(macUpdater.close).not.toHaveBeenCalled();
    finish();
    await Promise.all([download, closing]);
    expect(macUpdater.close).toHaveBeenCalledOnce();
    expect(states).toHaveLength(calls);
    expect(states.some((state) => state.status === "ready")).toBe(false);
  });
});
