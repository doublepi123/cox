import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vite-plus/test";
import { clearStaleGpuCaches } from "./gpu-cache.ts";

it("clears Chromium GPU caches once per Electron version and preserves other user data", () => {
  const dir = mkdtempSync(join(tmpdir(), "cox-gpu-cache-"));
  try {
    const gpuCache = join(dir, "GPUCache");
    const shaderCache = join(dir, "DawnGraphiteCache");
    const partitions = join(dir, "Partitions");
    mkdirSync(gpuCache);
    mkdirSync(partitions);
    clearStaleGpuCaches(dir, "39.1.0");
    expect(existsSync(gpuCache)).toBe(false);
    mkdirSync(shaderCache);
    clearStaleGpuCaches(dir, "39.1.0");
    expect(existsSync(shaderCache)).toBe(true);
    clearStaleGpuCaches(dir, "39.1.1");
    expect(existsSync(shaderCache)).toBe(false);
    expect(existsSync(partitions)).toBe(true);
    expect(readFileSync(join(dir, "gpu-cache-electron-version"), "utf8")).toBe("39.1.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
