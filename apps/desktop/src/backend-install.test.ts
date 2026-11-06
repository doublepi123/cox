import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  backendInstallerEnvironment,
  compareBackendVersions,
  downloadBackendRelease,
  fetchBackendRelease,
  isBackendVersion,
  parseBackendRelease,
} from "./backend-install.ts";

const archive = Buffer.from("verified Cox archive");
const metadata = {
  name: "@doublepi123/cox",
  version: "0.2.0",
  coxDesktop: { protocol: 1, nodeVersion: "26.12.1" },
  dist: {
    tarball: "https://registry.npmjs.org/@doublepi123/cox/-/cox-0.2.0.tgz",
    integrity: "sha512-" + createHash("sha512").update(archive).digest("base64"),
  },
};
describe("desktop backend release verification", () => {
  it("does not expose provider or publishing credentials to installer lifecycle commands", () => {
    expect(
      backendInstallerEnvironment({
        PATH: "/runtime/bin",
        HOME: "/user",
        SystemRoot: "C:\\Windows",
        OPENAI_API_KEY: "private",
        ANTHROPIC_API_KEY: "private",
        GH_TOKEN: "private",
        NODE_AUTH_TOKEN: "private",
        NPM_TOKEN: "private",
        npm_config_registry: "https://foreign.invalid",
        NODE_OPTIONS: "--import malicious",
        HTTPS_PROXY: "https://proxy.invalid",
      }),
    ).toEqual({
      PATH: "/runtime/bin",
      HOME: "/user",
      SystemRoot: "C:\\Windows",
      HTTPS_PROXY: "https://proxy.invalid",
    });
  });
  it("uses semantic version ordering rather than lexical ordering", () => {
    expect(compareBackendVersions("0.1.100", "0.1.99")).toBe(1);
    for (const invalid of ["../0.2.0", "0.2.0-beta", "01.2.3", "1.2", "999999999999999999.0.0"])
      expect(isBackendVersion(invalid)).toBe(false);
  });
  it("requires the official package, registry, integrity and runtime compatibility", () => {
    expect(parseBackendRelease(metadata, "26.12.1").compatible).toBe(true);
    expect(parseBackendRelease(metadata, "26.11.0").compatible).toBe(false);
    expect(parseBackendRelease(metadata, "27.0.0").compatible).toBe(false);
    expect(() => parseBackendRelease({ ...metadata, name: "someone/cox" }, "26.12.1")).toThrow();
    for (const tarball of [
      "https://evil.invalid/cox.tgz",
      "http://registry.npmjs.org/cox.tgz",
      metadata.dist.tarball + "?redirect=evil",
    ])
      expect(() =>
        parseBackendRelease({ ...metadata, dist: { ...metadata.dist, tarball } }, "26.12.1"),
      ).toThrow();
  });
  it("limits legacy compatibility to the known desktop-era releases", () => {
    expect(
      parseBackendRelease(
        {
          ...metadata,
          version: "0.1.41",
          coxDesktop: undefined,
          dist: { ...metadata.dist, tarball: metadata.dist.tarball.replace("0.2.0", "0.1.41") },
        },
        "26.12.1",
      ).compatible,
    ).toBe(true);
    expect(parseBackendRelease({ ...metadata, coxDesktop: undefined }, "26.12.1").compatible).toBe(
      false,
    );
  });
  it("checks SHA-512 before allowing an archive to be installed", async () => {
    const release = parseBackendRelease(metadata, "26.12.1");
    const fetcher = vi.fn<typeof fetch>(async () => new Response(archive));
    expect(await downloadBackendRelease(release, AbortSignal.timeout(1000), fetcher)).toEqual(
      archive,
    );
    fetcher.mockImplementation(async () => new Response("corrupted"));
    await expect(
      downloadBackendRelease(release, AbortSignal.timeout(1000), fetcher),
    ).rejects.toThrow("checksum");
  });
  it("does not follow registry redirects or accept a foreign download location", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(metadata)));
    await fetchBackendRelease("26.12.1", AbortSignal.timeout(1000), fetcher);
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error");
    await expect(
      downloadBackendRelease(
        { ...parseBackendRelease(metadata, "26.12.1"), url: "file:///etc/passwd" },
        AbortSignal.timeout(1000),
        fetcher,
      ),
    ).rejects.toThrow("official registry");
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
