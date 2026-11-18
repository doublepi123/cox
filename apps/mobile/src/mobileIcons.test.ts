// @effect-diagnostics nodeBuiltinImport:off - The icon check is a Node maintenance script.

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vite-plus/test";

const execFileAsync = promisify(execFile);

describe("mobile icons", () => {
  it("rejects Capacitor placeholder icons", async () => {
    const result = await execFileAsync(
      process.execPath,
      ["scripts/generate-icons.mjs", "--check"],
      { cwd: resolve(import.meta.dirname, "../../..") },
    );
    expect(result.stderr).toBe("");
  });
});
