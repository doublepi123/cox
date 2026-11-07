import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createDesktopUpdateFeed,
  planDesktopAssetUploads,
  uploadDesktopAssets,
  versionDesktopMetadata,
} from "./client-update-release.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const commit = "a".repeat(40);
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cox-release-feed-"));
  directories.push(directory);
  for (const flavor of ["bundled", "client-only"]) {
    for (const target of ["darwin-arm64", "darwin-x64", "win32-x64"]) {
      const [platform, architecture] = target.split("-");
      const backendVersion = flavor === "bundled" ? "0.1.44" : null;
      const filename = `cox-desktop-0.3.0-${flavor === "bundled" ? "cox-0.1.44" : flavor}-${platform === "darwin" ? "mac" : "win"}-${architecture}.${platform === "darwin" ? "dmg" : "exe"}`;
      const bytes = Buffer.from(filename);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(join(directory, filename), bytes);
      await writeFile(join(directory, filename + ".sha256"), `${sha256}  ${filename}\n`);
      await writeFile(
        join(directory, `UPDATE-${flavor}-${target}.json`),
        JSON.stringify({
          schema: 1,
          version: "0.3.0",
          clientCommit: commit,
          sourceDirty: false,
          flavor,
          platform,
          architecture,
          backendVersion,
          filename,
          size: bytes.length,
          sha256,
          sha512: createHash("sha512").update(bytes).digest("base64"),
          installMode: "manual",
        }),
      );
      await writeFile(
        join(directory, `BUILD-${flavor}-${target}.json`),
        JSON.stringify({
          version: "0.3.0",
          clientCommit: commit,
          sourceDirty: false,
          unpacked: false,
          flavor,
          platform,
          architecture,
          coxVersion: backendVersion,
          clientAutomaticUpdates: false,
        }),
      );
    }
  }
  return { directory, version: "0.3.0", clientCommit: commit };
}

afterEach(async () => {
  vi.mocked(execFileSync).mockReset();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("complete desktop update publication", () => {
  it("reads draft release assets before uploading by tag", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-release-upload-"));
    directories.push(directory);
    const filename = "cox-desktop-0.2.7-client-only-win-x64.exe";
    await writeFile(join(directory, filename), "installer");
    vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ assets: [] }));

    await uploadDesktopAssets(directory, "desktop-v0.2.7", "doublepi123/cox");

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      "gh",
      ["release", "view", "desktop-v0.2.7", "--repo", "doublepi123/cox", "--json", "assets"],
      { encoding: "utf8" },
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      "gh",
      [
        "release",
        "upload",
        "desktop-v0.2.7",
        "--repo",
        "doublepi123/cox",
        join(directory, filename),
      ],
      { stdio: "inherit" },
    );
  });

  it("publishes macOS automatic replacement only when both metadata records declare its protocol", async () => {
    const input = await fixture();
    for (const target of ["darwin-arm64", "darwin-x64"])
      for (const flavor of ["bundled", "client-only"]) {
        for (const prefix of ["BUILD", "UPDATE"]) {
          const path = join(input.directory, `${prefix}-${flavor}-${target}.json`);
          const value = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
          await writeFile(
            path,
            JSON.stringify({
              ...value,
              macUpdateProtocol: 1,
              clientAutomaticUpdates: true,
              ...(prefix === "UPDATE" ? { installMode: "automatic" } : {}),
            }),
          );
        }
      }
    const manifest = await createDesktopUpdateFeed(input);
    expect(
      manifest.artifacts
        .filter((artifact) => artifact.platform === "darwin")
        .every(
          (artifact) => artifact.installMode === "automatic" && artifact.macUpdateProtocol === 1,
        ),
    ).toBe(true);
  });
  it("skips identical assets while allowing a fresh backend combination", () => {
    const existing = [
      { name: "cox-desktop-0.3.0-cox-0.1.44-mac-arm64.dmg", size: 10, digest: "same" },
      { name: "BUILD-bundled-darwin-arm64-client-0.3.0-cox-0.1.44.json", size: 20, digest: "old" },
    ];
    expect(
      planDesktopAssetUploads(
        [
          ...existing.slice(0, 1),
          { name: "cox-desktop-0.3.0-cox-0.1.45-mac-arm64.dmg", size: 11, digest: "new" },
          {
            name: "BUILD-bundled-darwin-arm64-client-0.3.0-cox-0.1.45.json",
            size: 20,
            digest: "new",
          },
        ],
        existing,
      ),
    ).toEqual({
      upload: [
        "cox-desktop-0.3.0-cox-0.1.45-mac-arm64.dmg",
        "BUILD-bundled-darwin-arm64-client-0.3.0-cox-0.1.45.json",
      ],
    });
  });

  it.each([
    "cox-desktop-0.3.0-client-only-win-x64.exe",
    "desktop-update-0.3.0.json",
    "cox-desktop-0.3.0-client-only-win-x64.exe.sha256",
    "BUILD-bundled-darwin-arm64-client-0.3.0-cox-0.1.44.json",
  ])("rejects replacement of immutable asset %s", (name) => {
    expect(() =>
      planDesktopAssetUploads(
        [{ name, size: 11, digest: "new" }],
        [{ name, size: 10, digest: "old" }],
      ),
    ).toThrow("immutable");
  });
  it("gives build metadata both version identities without changing its contents", async () => {
    const { directory } = await fixture();
    const contents = await readFile(join(directory, "BUILD-bundled-darwin-arm64.json"));
    await versionDesktopMetadata(directory);
    expect(
      await readFile(join(directory, "BUILD-bundled-darwin-arm64-client-0.3.0-cox-0.1.44.json")),
    ).toEqual(contents);
    await expect(readFile(join(directory, "BUILD-bundled-darwin-arm64.json"))).rejects.toThrow();
    expect(
      JSON.parse(
        await readFile(join(directory, "UPDATE-client-only-win32-x64-client-0.3.0.json"), "utf8"),
      ),
    ).toMatchObject({ version: "0.3.0", backendVersion: null });
  });
  it("builds a six-target feed pinned to immutable official release URLs", async () => {
    const release = await createDesktopUpdateFeed(await fixture());
    expect(release.tag).toBe("desktop-v0.3.0");
    expect(release.artifacts).toHaveLength(6);
    expect(
      release.artifacts.every((artifact) =>
        artifact.url.startsWith(
          "https://github.com/doublepi123/cox/releases/download/desktop-v0.3.0/",
        ),
      ),
    ).toBe(true);
    expect(release.artifacts.every((artifact) => artifact.installMode === "manual")).toBe(true);
  });

  it("refuses incomplete target sets including a missing client-only build", async () => {
    const input = await fixture();
    await rm(join(input.directory, "UPDATE-client-only-win32-x64.json"));
    await expect(createDesktopUpdateFeed(input)).rejects.toThrow();
  });

  it("detects corruption of actual installer bytes and checksum sidecars", async () => {
    const input = await fixture();
    const feed = await createDesktopUpdateFeed(input);
    const installer = join(input.directory, feed.artifacts[0]!.filename);
    const original = await readFile(installer);
    await writeFile(installer, "tampered");
    await expect(createDesktopUpdateFeed(input)).rejects.toThrow("tested update metadata");
    await writeFile(installer, original);
    await writeFile(installer + ".sha256", "wrong");
    await expect(createDesktopUpdateFeed(input)).rejects.toThrow("sidecar");
  });

  it.each([
    { sourceDirty: true },
    { clientCommit: "b".repeat(40) },
    { version: "0.3.1" },
    { coxVersion: "0.1.45" },
    { unpacked: true },
    { architecture: "arm64" },
  ])("rejects build identity mismatches %j", async (change) => {
    const input = await fixture();
    const path = join(input.directory, "BUILD-bundled-win32-x64.json");
    const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...metadata, ...change }));
    await expect(createDesktopUpdateFeed(input)).rejects.toThrow("tested build");
  });

  it("does not advertise unsigned Windows builds as automatic", async () => {
    const input = await fixture();
    const path = join(input.directory, "UPDATE-bundled-win32-x64.json");
    const metadata = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...metadata, installMode: "automatic" }));
    await expect(createDesktopUpdateFeed(input)).rejects.toThrow("tested build");
  });
});
