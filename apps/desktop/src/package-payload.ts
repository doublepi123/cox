import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

async function removeSourceMaps(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeSourceMaps(path);
    else if (entry.isFile() && entry.name.endsWith(".map")) await rm(path);
  }
}

export async function pruneDesktopPayload(options: {
  runtime: string;
  server: string;
  platform: string;
  architecture: string;
}): Promise<void> {
  await pruneBackendPayload(options);
  await rm(join(options.runtime, "include"), { recursive: true, force: true });
  await rm(join(options.runtime, "share", "man"), { recursive: true, force: true });
}

export async function pruneBackendPayload(options: {
  server: string;
  platform: string;
  architecture: string;
}): Promise<void> {
  const target = `${options.platform}-${options.architecture}`;
  if (!/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(target))
    throw new Error(`Unsupported desktop target: ${target}`);
  const bridge = `cox-protocol-bridge-${target}${options.platform === "win32" ? ".exe" : ""}`;
  for (const filename of await readdir(join(options.server, "dist"))) {
    if (
      /^cox-protocol-bridge-(?:darwin|linux|win32)-(?:arm64|x64)(?:\.exe)?$/.test(filename) &&
      filename !== bridge
    )
      await rm(join(options.server, "dist", filename));
  }
  const prebuilds = join(options.server, "node_modules", "node-pty", "prebuilds");
  const entries = await readdir(prebuilds).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const filename of entries) {
    if (/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(filename) && filename !== target)
      await rm(join(prebuilds, filename), { recursive: true });
  }
  await removeSourceMaps(options.server);
}
