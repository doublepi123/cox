import { describe, expect, it, vi } from "vite-plus/test";
import { latestDesktopTag, resolveDesktopRelease } from "./release-plan.ts";

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
    expect(latest).toHaveBeenCalledWith("26.12.1", "0.1.99", "latest");
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
