import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { build, Platform, Arch } from "electron-builder";

const directory = resolve(import.meta.dirname, "..");
const root = resolve(directory, "../..");
const unpacked = process.argv.includes("--dir");
if (!["darwin", "win32"].includes(process.platform) && !unpacked) {
  throw new Error(
    "Build macOS installers on macOS and Windows installers on Windows. --dir is available for local validation.",
  );
}
if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported desktop architecture.");
const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as {
  version: string;
  devDependencies: { electron: string };
};
const workspace = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
};
if (manifest.version !== workspace.version)
  throw new Error("Desktop and workspace versions must match.");
const nodeVersion = workspace.engines.node;
if (!/^\d+\.\d+\.\d+$/.test(nodeVersion))
  throw new Error("The desktop runtime must use an exact Node version.");
const platform = process.platform === "win32" ? "win" : process.platform;
const name = `node-v${nodeVersion}-${platform}-${process.arch}`;
const filename = `${name}.${process.platform === "win32" ? "zip" : "tar.gz"}`;
const cache = join(root, "release", "desktop-cache");
await mkdir(cache, { recursive: true });
const download = async (url: string) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
};
const checksums = (
  await download(`https://nodejs.org/dist/v${nodeVersion}/SHASUMS256.txt`)
).toString();
const expected = checksums
  .split("\n")
  .map((line) => line.trim().split(/\s+/))
  .find((entry) => entry[1] === filename)?.[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected))
  throw new Error("The Node distribution checksum is missing.");
const archive = join(cache, filename);
let bytes: Buffer;
try {
  bytes = await readFile(archive);
} catch {
  bytes = await download(`https://nodejs.org/dist/v${nodeVersion}/${filename}`);
}
if (createHash("sha256").update(bytes).digest("hex") !== expected)
  throw new Error(
    "The Node distribution checksum does not match; remove the cached archive and retry.",
  );
await writeFile(archive, bytes);
const stage = join(root, "release", "desktop-stage");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
execFileSync("tar", ["-xf", archive, "-C", stage], { stdio: "inherit" });
const runtime = join(stage, "runtime");
await cp(join(stage, name), runtime, { recursive: true, verbatimSymlinks: true });
await rm(join(stage, name), { recursive: true, force: true });
const node =
  process.platform === "win32" ? join(runtime, "node.exe") : join(runtime, "bin", "node");
const npm =
  process.platform === "win32"
    ? join(runtime, "node_modules", "npm", "bin", "npm-cli.js")
    : join(runtime, "lib", "node_modules", "npm", "bin", "npm-cli.js");
await chmod(node, 0o755);
execFileSync(node, [join(root, "scripts/package-npm.ts"), "--no-pack"], {
  cwd: root,
  stdio: "inherit",
});
const server = join(stage, "server");
await cp(join(root, "release/npm"), server, { recursive: true });
const serverManifestPath = join(server, "package.json");
const serverManifest = JSON.parse(await readFile(serverManifestPath, "utf8")) as {
  dependencies: Record<string, string>;
};
await writeFile(
  serverManifestPath,
  JSON.stringify(
    {
      ...serverManifest,
      allowScripts: { [`node-pty@${serverManifest.dependencies["node-pty"]}`]: true },
    },
    null,
    2,
  ),
);
const environment = {
  ...process.env,
  PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}`,
};
execFileSync(node, [npm, "install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: server,
  env: environment,
  stdio: "inherit",
});
execFileSync(
  node,
  [
    "--input-type=module",
    "-e",
    "import { createRequire } from 'node:module'; const require = createRequire(process.cwd() + '/package.json'); require('node-pty'); require('@napi-rs/keyring');",
  ],
  { cwd: server, env: environment, stdio: "inherit" },
);
const application = join(stage, "app");
const licenses = join(stage, "licenses");
await mkdir(licenses);
for (const filename of ["LICENSE", "LICENSES.chromium.html"]) {
  await cp(
    join(directory, "node_modules", "electron", "dist", filename),
    join(licenses, filename === "LICENSE" ? "LICENSE.electron.txt" : filename),
  );
}
await mkdir(application);
await cp(join(directory, "dist"), join(application, "dist"), { recursive: true });
await cp(join(root, "LICENSE"), join(application, "LICENSE"));
await cp(join(server, "THIRD_PARTY_NOTICES.json"), join(application, "THIRD_PARTY_NOTICES.json"));
await writeFile(
  join(application, "package.json"),
  JSON.stringify(
    {
      name: "cox-desktop",
      productName: "Cox",
      version: manifest.version,
      description: "Local-only coding agent workspace",
      author: "Cox contributors",
      license: "MIT",
      type: "module",
      main: "dist/main.js",
    },
    null,
    2,
  ),
);
const targetPlatform =
  process.platform === "darwin"
    ? Platform.MAC
    : process.platform === "win32"
      ? Platform.WINDOWS
      : Platform.LINUX;
const architecture = process.arch === "arm64" ? Arch.arm64 : Arch.x64;
const output = join(root, "release", "desktop");
await mkdir(output, { recursive: true });
const artifacts = await build({
  targets: targetPlatform.createTarget(
    unpacked ? ["dir"] : process.platform === "darwin" ? ["dmg", "zip"] : ["nsis"],
    architecture,
  ),
  projectDir: directory,
  config: {
    appId: "dev.cox.desktop",
    productName: "Cox",
    electronVersion: manifest.devDependencies.electron,
    directories: { app: application, output },
    files: ["dist/**", "package.json", "LICENSE", "THIRD_PARTY_NOTICES.json"],
    asar: true,
    npmRebuild: false,
    publish: null,
    artifactName: "Cox-${version}-${os}-${arch}.${ext}",
    extraResources: [
      { from: join(directory, "dist", "backend-parent.js"), to: "backend-parent.mjs" },
      { from: licenses, to: "licenses" },
      { from: runtime, to: "runtime" },
      ...(process.platform === "win32"
        ? [{ from: join(runtime, "node_modules"), to: "runtime/node_modules" }]
        : []),
      { from: server, to: "server", filter: ["**/*", "!**/*.map", "!**/package-lock.json"] },
      { from: join(server, "node_modules"), to: "server/node_modules" },
      { from: join(root, "apps/web/public/icon-512.png"), to: "icon.png" },
    ],
    mac: {
      category: "public.app-category.developer-tools",
      icon: join(root, "apps/web/public/icon-512.png"),
      hardenedRuntime: true,
      entitlements: join(directory, "entitlements.mac.plist"),
      entitlementsInherit: join(directory, "entitlements.mac.plist"),
      binaries: ["Contents/Resources/runtime/bin/node"],
    },
    win: { icon: join(root, "apps/web/public/icon-512.png") },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      deleteAppDataOnUninstall: false,
    },
    linux: { icon: join(root, "apps/web/public/icon-512.png") },
  },
});
for (const artifact of artifacts) {
  const contents = await readFile(artifact);
  await writeFile(
    `${artifact}.sha256`,
    `${createHash("sha256").update(contents).digest("hex")}  ${artifact.split(/[\\/]/).at(-1)}\n`,
  );
}
await writeFile(
  join(output, `BUILD-${process.platform}-${process.arch}.json`),
  `${JSON.stringify({ version: manifest.version, platform: process.platform, architecture: process.arch, node: nodeVersion, electron: manifest.devDependencies.electron, unpacked, artifacts }, null, 2)}\n`,
);
console.log(`Desktop output: ${output}`);
console.log(`Output entries: ${(await readdir(output)).join(", ")}`);
