import { describe, expect, it, vi } from "vite-plus/test";

const execute = vi.hoisted(() => vi.fn(async () => ({ stdout: "", stderr: "" })));

vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  promisify: () => execute,
}));

import { macCommand } from "./mac-update-platform.ts";

describe("macOS update command paths", () => {
  it.each([
    ["spctl", "/usr/sbin/spctl"],
    ["codesign", "/usr/bin/codesign"],
    ["plutil", "/usr/bin/plutil"],
    ["lipo", "/usr/bin/lipo"],
  ])("resolves %s to its system executable", async (command, executable) => {
    await macCommand(command, ["--version"]);
    expect(execute).toHaveBeenLastCalledWith(
      executable,
      ["--version"],
      expect.objectContaining({ timeout: 120_000 }),
    );
  });
});
