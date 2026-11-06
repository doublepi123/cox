import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { macCommand, verifyMacApplication } from "./mac-update-platform.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cox-mac-signatures-"));
  directories.push(root);
  const application = join(root, "Cox.app");
  await mkdir(join(application, "Contents/Resources"), { recursive: true });
  const metadata = {
    desktopVersion: "0.2.5",
    architecture: "arm64",
    platform: "darwin",
    flavor: "bundled",
    coxVersion: "0.1.44",
    macUpdateProtocol: 1,
    clientAutomaticUpdates: true,
  };
  await writeFile(join(application, "Contents/Resources/backend.json"), JSON.stringify(metadata));
  const command = vi.fn<typeof macCommand>(async (name) => ({
    stdout:
      name === "plutil"
        ? JSON.stringify({
            CFBundleIdentifier: "dev.cox.desktop",
            CFBundleExecutable: "Cox",
            CFBundleShortVersionString: "0.2.5",
          })
        : name === "lipo"
          ? "arm64"
          : "",
    stderr: name === "codesign" ? "Signature=adhoc\nTeamIdentifier=not set\n" : "",
  }));
  const candidate = {
    version: "0.2.5",
    architecture: "arm64" as const,
    flavor: "bundled" as const,
    backendVersion: "0.1.44",
  };
  return { application, metadata, command, candidate };
}

describe("macOS update verification", () => {
  it("accepts a verified ad-hoc bundle without stripping quarantine or changing its signature", async () => {
    const test = await fixture();
    await verifyMacApplication(test.application, test.candidate, undefined, test.command);
    expect(
      test.command.mock.calls.some(
        ([name, args]) => name === "codesign" && args.includes("--strict"),
      ),
    ).toBe(true);
    expect(test.command.mock.calls.some(([name]) => name === "xattr")).toBe(false);
  });
  it("rejects incompatible bundle identity, protocol and architecture", async () => {
    const test = await fixture();
    await expect(
      verifyMacApplication(
        test.application,
        { ...test.candidate, version: "0.2.6" },
        undefined,
        test.command,
      ),
    ).rejects.toThrow("identity or version");
    await writeFile(
      join(test.application, "Contents/Resources/backend.json"),
      JSON.stringify({ ...test.metadata, macUpdateProtocol: 2 }),
    );
    await expect(
      verifyMacApplication(test.application, test.candidate, undefined, test.command),
    ).rejects.toThrow("automatic replacement");
    await writeFile(
      join(test.application, "Contents/Resources/backend.json"),
      JSON.stringify(test.metadata),
    );
    const original = test.command.getMockImplementation()!;
    test.command.mockImplementation(async (name, args) =>
      name === "lipo" ? { stdout: "x86_64", stderr: "" } : original(name, args),
    );
    await expect(
      verifyMacApplication(test.application, test.candidate, undefined, test.command),
    ).rejects.toThrow("CPU architecture");
  });
  it("preserves the signing team and requires system assessment for Developer ID updates", async () => {
    const test = await fixture();
    const original = test.command.getMockImplementation()!;
    test.command.mockImplementation(async (name, args) =>
      name === "codesign" && args.includes("--display")
        ? {
            stdout: "",
            stderr: `TeamIdentifier=${args.at(-1) === "/old/Cox.app" ? "AAAAAAAAAA" : "BBBBBBBBBB"}\n`,
          }
        : original(name, args),
    );
    await expect(
      verifyMacApplication(test.application, test.candidate, "/old/Cox.app", test.command),
    ).rejects.toThrow("signing identity");
    test.command.mockImplementation(async (name, args) =>
      name === "codesign" && args.includes("--display")
        ? { stdout: "", stderr: "TeamIdentifier=AAAAAAAAAA\n" }
        : original(name, args),
    );
    await verifyMacApplication(test.application, test.candidate, "/old/Cox.app", test.command);
    expect(test.command).toHaveBeenCalledWith("spctl", [
      "--assess",
      "--type",
      "execute",
      test.application,
    ]);
  });
});
