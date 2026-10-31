import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const temporaryDirectories: string[] = [];
const source = dirname(import.meta.dirname);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cox-release-test-"));
  temporaryDirectories.push(root);
  const write = async (relative: string, contents: string) => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  };
  await write(
    "package.json",
    JSON.stringify({
      version: "0.1.0",
      type: "module",
      engines: { node: "26.12.1" },
      packageManager: "pnpm@12.14.0",
    }),
  );
  for (const app of ["server", "web"]) {
    await write(`apps/${app}/package.json`, JSON.stringify({ version: "0.1.0", dependencies: {} }));
  }
  await write(".gitignore", ".env\n.cox/\nnode_modules/\n**/dist/\nrelease/\n");
  await write("README.md", "Cox distribution fixture\n");
  await write("LICENSE", "Fixture license\n");
  await write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await write("third-party-licenses.config.json", '{"customNotices":[],"packageOverrides":[]}');
  await mkdir(join(root, "scripts/lib"), { recursive: true });
  await cp(join(source, "scripts/package-release.ts"), join(root, "scripts/package-release.ts"));
  await cp(
    join(source, "scripts/lib/third-party-licenses.ts"),
    join(root, "scripts/lib/third-party-licenses.ts"),
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Cox tests");
  git("config", "user.email", "cox@localhost");
  git("add", ".");
  git("commit", "-m", "Release fixture");
  await write("apps/server/dist/bin.mjs", "console.log('fixture');\n");
  await write("apps/server/dist/client/index.html", "<title>Cox</title>\n");
  await write("apps/server/dist/client/third-party-licenses.json", '{"entries":[]}');
  await write(".env", "SECRET=must-not-ship");
  await write(".cox/private.json", '{"token":"must-not-ship"}');
  await write("node_modules/private.txt", "must-not-ship");
  const pack = () =>
    execFileSync(process.execPath, ["scripts/package-release.ts"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });
  return { root, git, write, pack };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("release distribution", () => {
  it("packages committed source and built assets, not local state or dependencies", async () => {
    const { root, git, pack } = await fixture();
    pack();
    const archive = join(root, "release/cox-v0.1.0.tar.gz");
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(entries).toContain("cox-v0.1.0/README.md");
    expect(entries).toContain("cox-v0.1.0/LICENSE");
    expect(entries).toContain("cox-v0.1.0/pnpm-lock.yaml");
    expect(entries).toContain("cox-v0.1.0/apps/server/dist/client/index.html");
    expect(entries).toContain("cox-v0.1.0/THIRD_PARTY_NOTICES.json");
    expect(entries).not.toMatch(/\/(?:\.git|\.cox|node_modules|\.env)(?:\/|\n)/);
    const release = JSON.parse(
      execFileSync("tar", ["-xOzf", archive, "cox-v0.1.0/RELEASE.json"], { encoding: "utf8" }),
    );
    expect(release.commit).toBe(git("rev-parse", "HEAD"));
    expect(release.distribution).toBe("source-with-prebuilt-web-and-server");
    const checksum = await readFile(join(root, "release/SHA256SUMS"), "utf8");
    pack();
    expect(await readFile(join(root, "release/SHA256SUMS"), "utf8")).toBe(checksum);
    execFileSync("sha256sum", ["-c", "SHA256SUMS"], { cwd: join(root, "release") });
  });

  it("rejects modified source and mismatched package versions", async () => {
    const { git, write, pack } = await fixture();
    await write("README.md", "Uncommitted changes\n");
    expect(pack).toThrow(/Commit all source changes/);
    git("checkout", "--", "README.md");
    await write("apps/server/package.json", '{"version":"0.2.0","dependencies":{}}');
    git("add", "apps/server/package.json");
    git("commit", "-m", "Mismatched version fixture");
    expect(pack).toThrow(/release versions must agree/);
  });
});
