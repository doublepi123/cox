import { describe, expect, it, vi } from "vite-plus/test";
import { desktopLatestNotes, desktopLatestTag, syncDesktopLatest } from "./sync-latest.ts";

const commit = "1234567890abcdef1234567890abcdef12345678";
const release = (version = "0.2.3", backend = "0.1.42", clientOnly = true) => {
  const names = [`DESKTOP-SHA256SUMS-client-${version}-cox-${backend}.txt`];
  for (const suffix of ["mac-arm64.dmg", "mac-x64.dmg", "win-x64.exe"]) {
    for (const flavor of clientOnly ? [`cox-${backend}`, "client-only"] : [`cox-${backend}`]) {
      const installer = `cox-desktop-${version}-${flavor}-${suffix}`;
      names.push(installer, installer + ".sha256");
    }
  }
  return {
    tag_name: `desktop-v${version}`,
    draft: false,
    prerelease: false,
    assets: names.map((name) => ({ name, size: 100 })),
  };
};

function fixture(existing = false) {
  const source = release();
  const api = vi.fn(
    async (path: string, method = "GET", _body?: Readonly<Record<string, unknown>>) => {
      if (method !== "GET") return { id: 99 };
      if (path.startsWith("releases?"))
        return [
          release("0.2.2"),
          source,
          { tag_name: "v9.0.0" },
          { tag_name: desktopLatestTag },
          { ...release("0.3.0"), draft: true },
          { ...release("0.4.0"), prerelease: true },
        ];
      if (path === `releases/tags/${source.tag_name}`) return source;
      if (path === `commits/${source.tag_name}`) return { sha: commit };
      if (path === `git/ref/tags/${desktopLatestTag}`)
        return existing ? { object: { sha: "old" } } : null;
      if (path === `releases/tags/${desktopLatestTag}`) return existing ? { id: 99 } : null;
      throw new Error("Unexpected request: " + path);
    },
  );
  return { api, source };
}

describe("rolling desktop download release", () => {
  it("creates only the rolling tag and release without changing server latest or copying assets", async () => {
    const { api } = fixture();
    expect(await syncDesktopLatest(api)).toBe("desktop-v0.2.3");
    expect(api).toHaveBeenCalledWith("git/refs", "POST", {
      ref: "refs/tags/cox-desktop-latest",
      sha: commit,
    });
    expect(api).toHaveBeenCalledWith(
      "releases",
      "POST",
      expect.objectContaining({
        tag_name: desktopLatestTag,
        target_commitish: commit,
        draft: false,
        prerelease: false,
        make_latest: "false",
      }),
    );
    const mutations = api.mock.calls.filter(([, method]) => method && method !== "GET");
    expect(mutations).toHaveLength(2);
  });

  it("updates an existing alias and always resolves the newest stable client instead of event order", async () => {
    const { api } = fixture(true);
    await syncDesktopLatest(api);
    expect(api).toHaveBeenCalledWith(`git/refs/tags/${desktopLatestTag}`, "PATCH", {
      sha: commit,
      force: true,
    });
    expect(api).toHaveBeenCalledWith(
      "releases/99",
      "PATCH",
      expect.objectContaining({ body: expect.stringContaining("releases/tag/desktop-v0.2.3") }),
    );
  });

  it("follows pagination rather than assuming the newest desktop release is on the first page", async () => {
    const { api } = fixture();
    api.mockImplementationOnce(async () =>
      Array.from({ length: 100 }, () => ({ tag_name: "v1.0.0" })),
    );
    await syncDesktopLatest(api);
    expect(api).toHaveBeenCalledWith("releases?per_page=100&page=2");
  });

  it("links three platforms, optional client-only packages and original checksum files", () => {
    const notes = desktopLatestNotes(release());
    for (const suffix of ["mac-arm64.dmg", "mac-x64.dmg", "win-x64.exe"]) {
      expect(notes).toContain(
        `releases/download/desktop-v0.2.3/cox-desktop-0.2.3-cox-0.1.42-${suffix}`,
      );
      expect(notes).toContain(`cox-desktop-0.2.3-client-only-${suffix}.sha256`);
    }
    expect(notes).toContain("DESKTOP-SHA256SUMS-client-0.2.3-cox-0.1.42.txt");
    expect(desktopLatestNotes(release("0.2.3", "0.1.42", false))).not.toContain(
      "cox-desktop-0.2.3-client-only-",
    );
  });

  it("selects the latest bundled backend numerically while keeping old assets intact", () => {
    const source = release("0.2.3", "0.1.9");
    source.assets.push(...release("0.2.3", "0.1.10").assets);
    const notes = desktopLatestNotes(source);
    expect(notes).toContain("**0.1.10**");
    expect(notes).not.toContain("cox-0.1.9-");
    expect(source.assets.some(({ name }) => name.includes("cox-0.1.9-"))).toBe(true);
  });

  it("rejects incomplete downloads before mutating the alias", async () => {
    const { api, source } = fixture();
    source.assets = source.assets.filter(({ name }) => !name.endsWith("win-x64.exe.sha256"));
    await expect(syncDesktopLatest(api)).rejects.toThrow("Missing desktop release asset");
    expect(api.mock.calls.every(([, method]) => !method || method === "GET")).toBe(true);
  });

  it("rejects unpublished, prerelease, server and empty releases", () => {
    for (const source of [
      { ...release(), draft: true },
      { ...release(), prerelease: true },
      { ...release(), tag_name: "v1.0.0" },
      { ...release(), tag_name: desktopLatestTag },
      { ...release(), assets: [] },
    ]) {
      expect(() => desktopLatestNotes(source)).toThrow();
    }
  });

  it("rejects a missing source commit before any mutation", async () => {
    const { api } = fixture();
    api.mockImplementationOnce(async () => [release()]);
    api.mockImplementationOnce(async () => release());
    api.mockImplementationOnce(async () => ({ sha: "not-a-commit" }));
    await expect(syncDesktopLatest(api)).rejects.toThrow("Invalid desktop source commit");
    expect(api.mock.calls.every(([, method]) => !method || method === "GET")).toBe(true);
  });
});
