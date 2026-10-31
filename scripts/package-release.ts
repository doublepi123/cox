import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateThirdPartyLicenseManifest } from "./lib/third-party-licenses.ts";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

if (git("rev-parse", "--show-toplevel") !== root) {
  throw new Error("The Cox checkout must be its own Git repository.");
}
if (git("status", "--porcelain")) {
  throw new Error("Commit all source changes before packaging a release.");
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
  packageManager: string;
};
const server = JSON.parse(await readFile(join(root, "apps/server/package.json"), "utf8")) as {
  version: string;
};
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) {
  throw new Error("The release version must be a valid semantic version.");
}
if (server.version !== manifest.version) {
  throw new Error("Workspace and server release versions must agree.");
}
const client = join(root, "apps/server/dist/client");
await readFile(join(root, "apps/server/dist/bin.mjs"));
await readFile(join(client, "index.html"));
await readFile(join(client, "third-party-licenses.json"));

const notices = await generateThirdPartyLicenseManifest({
  configFile: join(root, "third-party-licenses.config.json"),
  packageManifests: [
    { bundle: "server", path: join(root, "apps/server/package.json") },
    { bundle: "web", path: join(root, "apps/web/package.json") },
  ],
});
const commit = git("rev-parse", "HEAD");
const timestamp = git("show", "-s", "--format=%ct", "HEAD");
const name = `cox-v${manifest.version}`;
const output = join(root, "release");
const temporary = await mkdtemp(join(tmpdir(), "cox-release-"));
try {
  const sourceTar = join(temporary, "source.tar");
  const staged = join(temporary, name);
  await mkdir(staged);
  execFileSync("git", ["archive", "--format=tar", `--output=${sourceTar}`, "HEAD"], {
    cwd: root,
  });
  execFileSync("tar", ["-xf", sourceTar, "-C", staged]);
  await cp(join(root, "apps/server/dist"), join(staged, "apps/server/dist"), {
    recursive: true,
  });
  await writeFile(
    join(staged, "THIRD_PARTY_NOTICES.json"),
    `${JSON.stringify(notices, null, 2)}\n`,
  );
  await writeFile(
    join(staged, "RELEASE.json"),
    `${JSON.stringify(
      {
        version: manifest.version,
        commit,
        node: manifest.engines.node,
        packageManager: manifest.packageManager,
        distribution: "source-with-prebuilt-web-and-server",
        dependencyInstall: "pnpm install --frozen-lockfile",
        start: "pnpm start",
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(output, { recursive: true });
  const filename = `${name}.tar.gz`;
  const archive = join(output, filename);
  execFileSync("tar", [
    "--sort=name",
    `--mtime=@${timestamp}`,
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "-czf",
    archive,
    "-C",
    temporary,
    name,
  ]);
  const checksum = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex");
  await writeFile(join(output, "SHA256SUMS"), `${checksum}  ${filename}\n`);
  console.log(`Created ${archive} from ${commit}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
