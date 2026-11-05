import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { pruneDesktopPayload } from "./package-payload.ts";

describe("desktop payload pruning", () => {
  for (const [platform, architecture] of [
    ["darwin", "arm64"],
    ["darwin", "x64"],
    ["win32", "x64"],
    ["linux", "x64"],
  ] as const) {
    it(`retains runtime, licenses and only ${platform}-${architecture} native payloads`, async () => {
      const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-payload-"));
      const runtime = join(temporary, "runtime");
      const server = join(temporary, "server");
      const targets = [
        "darwin-arm64",
        "darwin-x64",
        "win32-arm64",
        "win32-x64",
        "linux-arm64",
        "linux-x64",
      ];
      const bridge = (target: string) =>
        `server/dist/cox-protocol-bridge-${target}${target.startsWith("win32") ? ".exe" : ""}`;
      const retained = [
        "runtime/LICENSE",
        "runtime/bin/node",
        "runtime/lib/node_modules/npm/bin/npm-cli.js",
        "server/LICENSE",
        "server/THIRD_PARTY_NOTICES.json",
        "server/dist/cox-protocol-bridge-NOTICES.json",
        "server/dist/bin.mjs",
        "server/dist/client/assets/viewer.wasm",
        "server/node_modules/node-pty/LICENSE",
        "server/node_modules/node-pty/build/Release/pty.node",
        "server/node_modules/example/index.js",
        bridge(`${platform}-${architecture}`),
        `server/node_modules/node-pty/prebuilds/${platform}-${architecture}/pty.node`,
      ];
      const removed = [
        "runtime/include/node/node.h",
        "runtime/share/man/man1/node.1",
        "server/dist/bin.mjs.map",
        "server/node_modules/example/index.js.map",
        ...targets.flatMap((target) =>
          target === `${platform}-${architecture}`
            ? []
            : [bridge(target), `server/node_modules/node-pty/prebuilds/${target}/pty.node`],
        ),
      ];
      try {
        for (const filename of [...retained, ...removed]) {
          const path = join(temporary, filename);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, filename);
        }
        await pruneDesktopPayload({ runtime, server, platform, architecture });
        for (const filename of retained)
          expect(await readFile(join(temporary, filename), "utf8")).toBe(filename);
        for (const filename of removed)
          await expect(readFile(join(temporary, filename))).rejects.toMatchObject({
            code: "ENOENT",
          });
        await pruneDesktopPayload({ runtime, server, platform, architecture });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
});
