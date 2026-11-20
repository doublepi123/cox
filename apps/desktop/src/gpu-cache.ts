import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function clearStaleGpuCaches(userDataPath: string, electronVersion: string): void {
  const marker = join(userDataPath, "gpu-cache-electron-version");
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === electronVersion) return;
  for (const name of [
    "GPUCache",
    "GrShaderCache",
    "ShaderCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GPUPersistentCache",
  ]) {
    rmSync(join(userDataPath, name), { recursive: true, force: true });
  }
  writeFileSync(marker, electronVersion, { mode: 0o600 });
}
