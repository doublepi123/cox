import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import { generateThirdPartyLicenseManifest } from "./lib/third-party-licenses.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;
const manifest = (await readJson(join(root, "package.json"))) as { version: string };
const server = (await readJson(join(root, "apps/server/package.json"))) as {
  version: string;
  dependencies: Record<string, string>;
  engines: { node: string };
};
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error("The release version must be a valid semantic version.");
}
if (manifest.version !== server.version) {
  throw new Error("Workspace and server release versions must agree.");
}
if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== `v${manifest.version}`) {
  throw new Error("The release tag must match the package version.");
}
await readFile(join(root, "apps/server/dist/bin.mjs"));
await readFile(join(root, "apps/server/dist/client/index.html"));

const runtime = new Set([
  ...Object.keys(selectCliRuntimeExternalDependencies(server.dependencies)),
  "diff",
]);
const dependencies = Object.fromEntries(
  await Promise.all(
    [...runtime].map(async (name) => {
      const installed = (await readJson(
        join(root, "apps/server/node_modules", name, "package.json"),
      )) as { version: string };
      return [name, installed.version];
    }),
  ),
);
const workspace = parse(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) as {
  patchedDependencies?: Record<string, string>;
};
const patches = Object.entries(workspace.patchedDependencies ?? {}).flatMap(([key, file]) => {
  const separator = key.lastIndexOf("@");
  const name = key.slice(0, separator);
  if (!Object.hasOwn(dependencies, name)) return [];
  const version = key.slice(separator + 1);
  if (dependencies[name] !== version) {
    throw new Error(`The runtime patch for ${key} does not match the installed version.`);
  }
  return [{ name, version, file: basename(file), source: file }];
});
const notices = await generateThirdPartyLicenseManifest({
  configFile: join(root, "third-party-licenses.config.json"),
  packageManifests: [
    { bundle: "server", path: join(root, "apps/server/package.json") },
    { bundle: "web", path: join(root, "apps/web/package.json") },
  ],
});
const output = join(root, "release/npm");
await rm(output, { recursive: true, force: true });
await mkdir(join(output, "patches"), { recursive: true });
await cp(join(root, "apps/server/dist"), join(output, "dist"), { recursive: true });
await chmod(join(output, "dist/bin.mjs"), 0o755);
for (const file of ["README.md", "LICENSE"]) {
  await cp(join(root, file), join(output, file));
}
await cp(join(root, "scripts/npm-postinstall.mjs"), join(output, "postinstall.mjs"));
for (const patch of patches) {
  await cp(join(root, patch.source), join(output, "patches", patch.file));
}
await writeFile(
  join(output, "patches/manifest.json"),
  `${JSON.stringify(
    patches.map(({ name, version, file }) => ({ name, version, file })),
    null,
    2,
  )}\n`,
);
await writeFile(join(output, "THIRD_PARTY_NOTICES.json"), `${JSON.stringify(notices, null, 2)}\n`);
await writeFile(
  join(output, "package.json"),
  `${JSON.stringify(
    {
      name: "@doublepi123/cox",
      version: manifest.version,
      description: "Local-only web workspace for coding agents",
      license: "MIT",
      type: "module",
      repository: { type: "git", url: "git+https://github.com/doublepi123/cox.git" },
      bin: { cox: "./dist/bin.mjs" },
      files: ["dist", "patches", "postinstall.mjs", "THIRD_PARTY_NOTICES.json"],
      scripts: { postinstall: "node postinstall.mjs" },
      engines: server.engines,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
      dependencies,
    },
    null,
    2,
  )}\n`,
);
execFileSync("npm", ["pack", "--ignore-scripts", "--quiet"], { cwd: output, stdio: "inherit" });
