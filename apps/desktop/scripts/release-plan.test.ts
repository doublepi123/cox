import { describe, expect, it, vi } from "vite-plus/test";
import {
  latestDesktopTag,
  resolveDesktopRelease,
  waitForPublishedBackend,
} from "./release-plan.ts";

const manifest = (version = "0.2.0") => ({
  encoding: "base64",
  content: Buffer.from(JSON.stringify({ version, engines: { node: "26.12.1" } })).toString(
    "base64",
  ),
});
const COMMIT = "1234567890abcdef1234567890abcdef12345678";
const clientApi = async (path: string) =>
  path.startsWith("commits/") ? { sha: COMMIT } : manifest();
describe("independent desktop release matrix", () => {
  it("selects the latest stable desktop version, not the latest Cox release or upload date", () => {
    expect(
      latestDesktopTag([
        { tag_name: "v9.0.0" },
        { tag_name: "desktop-v0.2.9" },
        { tag_name: "desktop-v0.2.10" },
        { tag_name: "desktop-v1.0.0", draft: true },
        { tag_name: "desktop-v2.0.0", prerelease: true },
      ]),
    ).toBe("desktop-v0.2.10");
    expect(() => latestDesktopTag([{ tag_name: "v0.1.41" }])).toThrow("first desktop-v");
  });
  it("builds bundled and client-only artifacts when a desktop tag is published", async () => {
    const latest = vi.fn(async () => ({ version: "0.1.99", integrity: "verified-fixture" }));
    const result = await resolveDesktopRelease({
      eventName: "push",
      refName: "desktop-v0.2.0",
      event: {},
      api: clientApi,
      latest,
    });
    expect(result).toMatchObject({
      client_ref: "desktop-v0.2.0",
      client_commit: COMMIT,
      client_version: "0.2.0",
      cox_version: "0.1.99",
      flavors: '["bundled","client-only"]',
      publish: "true",
      client_release: "true",
      skip: "false",
    });
    expect(latest).toHaveBeenCalledWith("26.12.1", undefined, "latest");
  });
  it("pairs a newly published Cox with the latest released client without rebuilding a client-only package", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.includes("/artifacts")) return { artifacts: [{ name: "cox-npm-v0.1.99" }] };
      if (path.startsWith("releases?"))
        return [{ tag_name: "desktop-v0.2.0" }, { tag_name: "v0.1.98" }];
      if (path.startsWith("commits/")) return { sha: COMMIT };
      return manifest();
    });
    const latest = vi.fn(async () => ({ version: "0.1.99", integrity: "verified-fixture" }));
    const result = await resolveDesktopRelease({
      eventName: "workflow_run",
      refName: "main",
      event: {
        workflow_run: {
          id: 123,
          conclusion: "success",
          head_repository: { full_name: "doublepi123/cox" },
        },
      },
      api,
      latest,
    });
    expect(result).toMatchObject({
      release_tag: "v0.1.99",
      client_ref: "desktop-v0.2.0",
      flavors: '["bundled"]',
      client_release: "false",
    });
    expect(latest).toHaveBeenCalledWith("26.12.1", "0.1.99", "0.1.99");
  });
  it("attaches bundled installers to an existing Cox tag from a manual run", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.startsWith("releases?"))
        return [{ tag_name: "desktop-v0.2.29" }, { tag_name: "v0.1.99" }];
      if (path.startsWith("commits/")) return { sha: COMMIT };
      return manifest("0.2.29");
    });
    const latest = vi.fn(async () => ({ version: "0.1.99", integrity: "verified-fixture" }));
    const result = await resolveDesktopRelease({
      eventName: "workflow_dispatch",
      refName: "main",
      event: { inputs: { cox_tag: "v0.1.99", publish: "true" } },
      api,
      latest,
    });
    expect(result).toMatchObject({
      release_tag: "v0.1.99",
      client_ref: "desktop-v0.2.29",
      client_version: "0.2.29",
      flavors: '["bundled"]',
      publish: "true",
      client_release: "false",
      skip: "false",
    });
    expect(latest).toHaveBeenCalledWith("26.12.1", "0.1.99", "0.1.99");
  });
  it("rejects mismatched client tags and failed/unofficial npm publications", async () => {
    await expect(
      resolveDesktopRelease({
        eventName: "push",
        refName: "desktop-v0.3.0",
        event: {},
        api: clientApi,
        latest: async () => ({ version: "0.1.99", integrity: "verified-fixture" }),
      }),
    ).rejects.toThrow("tag must match");
    await expect(
      resolveDesktopRelease({
        eventName: "workflow_run",
        refName: "main",
        event: { workflow_run: { conclusion: "failure" } },
        api: async () => ({}),
        latest: async () => ({ version: "0.1.99", integrity: "verified-fixture" }),
      }),
    ).rejects.toThrow("successful official");
  });
  it("skips prerelease Cox publications without resolving client sources or stable npm releases", async () => {
    const api = vi.fn(async () => ({ artifacts: [{ name: "cox-npm-v0.2.0-beta.1" }] }));
    const latest = vi.fn(async () => ({ version: "0.1.99", integrity: "verified-fixture" }));
    const result = await resolveDesktopRelease({
      eventName: "workflow_run",
      refName: "main",
      event: {
        workflow_run: {
          id: 123,
          conclusion: "success",
          head_repository: { full_name: "doublepi123/cox" },
        },
      },
      api,
      latest,
    });
    expect(result).toMatchObject({ skip: "true", publish: "false", flavors: "[]" });
    expect(api).toHaveBeenCalledExactlyOnceWith("actions/runs/123/artifacts");
    expect(latest).not.toHaveBeenCalled();
  });
  it("does not publish a test build from an untagged branch", async () => {
    await expect(
      resolveDesktopRelease({
        eventName: "workflow_dispatch",
        refName: "main",
        event: { inputs: { client_ref: "main", publish: "true" } },
        api: clientApi,
        latest: async () => ({ version: "0.1.99", integrity: "verified-fixture" }),
      }),
    ).rejects.toThrow("existing desktop-v");
  });
  it("allows adding a backend combination without rebuilding an existing client-only package", async () => {
    await expect(
      resolveDesktopRelease({
        eventName: "workflow_dispatch",
        refName: "main",
        event: { inputs: { client_ref: "desktop-v0.2.0", publish: "true", client_only: "false" } },
        api: clientApi,
        latest: async () => ({ version: "0.1.99", integrity: "verified-fixture" }),
      }),
    ).resolves.toMatchObject({
      publish: "true",
      client_release: "true",
      flavors: '["bundled"]',
      cox_version: "0.1.99",
    });
  });
});

describe("npm packument wait for combination releases", () => {
  it("requests the published version, not the latest dist-tag, and retries until it appears", async () => {
    const slept: number[] = [];
    const logs: string[] = [];
    const fetchRelease = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cox update download failed: HTTP 404"))
      .mockResolvedValueOnce({ version: "0.1.98", integrity: "stale", compatible: true })
      .mockResolvedValueOnce({
        version: "0.1.99",
        integrity: "verified-fixture",
        compatible: true,
      });
    await expect(
      waitForPublishedBackend(fetchRelease, {
        minimum: "0.1.99",
        version: "latest",
        attempts: 4,
        delayMs: 15,
        sleep: async (ms) => {
          slept.push(ms);
        },
        log: (message) => logs.push(message),
      }),
    ).resolves.toEqual({ version: "0.1.99", integrity: "verified-fixture" });
    expect(fetchRelease.mock.calls).toEqual([["0.1.99"], ["0.1.99"], ["0.1.99"]]);
    expect(slept).toEqual([15, 15]);
    expect(logs).toHaveLength(2);
  });
  it("retries until the published tarball itself can be downloaded", async () => {
    const slept: number[] = [];
    const confirmTarball = vi
      .fn()
      .mockRejectedValueOnce(new Error("Cox update download failed: HTTP 404"))
      .mockResolvedValueOnce(undefined);
    await expect(
      waitForPublishedBackend(
        async () => ({
          version: "0.1.105",
          integrity: "verified-fixture",
          compatible: true,
          url: "https://registry.npmjs.org/@doublepi123/cox/-/cox-0.1.105.tgz",
        }),
        {
          minimum: "0.1.105",
          version: "0.1.105",
          attempts: 3,
          delayMs: 15,
          sleep: async (ms) => {
            slept.push(ms);
          },
          log: () => {},
          confirmTarball,
        },
      ),
    ).resolves.toEqual({ version: "0.1.105", integrity: "verified-fixture" });
    expect(confirmTarball).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([15]);
  });
  it("does not retry an incompatible Cox release", async () => {
    const slept: number[] = [];
    const fetchRelease = vi.fn(async () => ({
      version: "0.1.99",
      integrity: "verified-fixture",
      compatible: false,
    }));
    await expect(
      waitForPublishedBackend(fetchRelease, {
        minimum: "0.1.99",
        version: "latest",
        attempts: 4,
        delayMs: 15,
        sleep: async (ms) => {
          slept.push(ms);
        },
        log: () => {},
      }),
    ).rejects.toThrow("newer compatible desktop client");
    expect(fetchRelease).toHaveBeenCalledOnce();
    expect(slept).toEqual([]);
  });
});
