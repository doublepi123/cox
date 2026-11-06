import { execFileSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { parse } from "yaml";

const source = dirname(import.meta.dirname);
const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const temporaryDirectories: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cox-npm-test-"));
  temporaryDirectories.push(root);
  const write = async (relative: string, contents: string) => {
    const path = join(root, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  };
  await write("package.json", '{"type":"module","version":"0.1.0","engines":{"node":"26.12.1"}}');
  await write(
    "apps/server/package.json",
    JSON.stringify({
      version: "0.1.0",
      engines: { node: ">=24.10" },
      dependencies: {
        "playwright-core": "^1.60.0",
        diff: "8.0.3",
        effect: "catalog:",
        "@t3tools/provider-core": "workspace:*",
      },
    }),
  );
  await write("apps/web/package.json", '{"dependencies":{}}');
  await write("pnpm-workspace.yaml", "patchedDependencies: {}\n");
  await write("third-party-licenses.config.json", '{"customNotices":[],"packageOverrides":[]}');
  await write("README.md", "Cox npm fixture\n");
  await write("LICENSE", "Fixture MIT license\n");
  await write("apps/server/dist/bin.mjs", "#!/usr/bin/env node\nconsole.log('fixture');\n");
  await write("apps/server/dist/client/index.html", "<title>Cox</title>\n");
  await write("apps/server/dist/claude-history-worker.mjs", "export {};\n");
  await write(".env", "SECRET=must-not-ship\n");
  await write(".cox/private.json", '{"token":"must-not-ship"}');
  for (const name of ["playwright-core", "diff", "effect", "@t3tools/provider-core"]) {
    await write(
      `apps/server/node_modules/${name}/package.json`,
      JSON.stringify({ name, version: "1.2.3", license: "MIT", main: "index.js" }),
    );
    await write(`apps/server/node_modules/${name}/index.js`, "export {};\n");
    await write(`apps/server/node_modules/${name}/LICENSE`, "Fixture MIT license\n");
  }
  for (const file of [
    "package-npm.ts",
    "npm-postinstall.mjs",
    "lib/cli-external-packages.ts",
    "lib/third-party-licenses.ts",
  ]) {
    await mkdir(dirname(join(root, "scripts", file)), { recursive: true });
    await cp(join(source, "scripts", file), join(root, "scripts", file));
  }
  await mkdir(join(root, "scripts/node_modules"), { recursive: true });
  await symlink(
    dirname(require.resolve("yaml/package.json")),
    join(root, "scripts/node_modules/yaml"),
  );
  const pack = (tag = "v0.1.0", extraArgs: ReadonlyArray<string> = []) =>
    execFileSync(process.execPath, ["scripts/package-npm.ts", ...extraArgs], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: tag },
      encoding: "utf8",
      stdio: "pipe",
    });
  return { root, write, pack };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("npm distribution", () => {
  it("can stage the runtime for desktop packaging without invoking npm pack", async () => {
    const { root, pack } = await fixture();
    pack("v0.1.0", ["--no-pack"]);
    const manifest = JSON.parse(await readFile(join(root, "release/npm/package.json"), "utf8"));
    expect(manifest.name).toBe("@doublepi123/cox");
    expect(await readFile(join(root, "release/npm/dist/bin.mjs"), "utf8")).toContain("fixture");
    await expect(readFile(join(root, "release/npm/doublepi123-cox-0.1.0.tgz"))).rejects.toThrow();
  });

  it("packs the scoped CLI, browser, workers and licenses without workspace or local state", async () => {
    const { root, pack } = await fixture();
    pack();
    const archive = join(root, "release/npm/doublepi123-cox-0.1.0.tgz");
    const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
    for (const file of [
      "dist/bin.mjs",
      "dist/client/index.html",
      "dist/claude-history-worker.mjs",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.json",
      "postinstall.mjs",
    ]) {
      expect(entries).toContain(`package/${file}`);
    }
    expect(entries).not.toMatch(/\/(?:\.git|\.cox|node_modules|\.env|src)(?:\/|\n)/);
    const manifest = JSON.parse(
      execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }),
    );
    expect(manifest.name).toBe("@doublepi123/cox");
    expect(manifest.bin).toEqual({ cox: "./dist/bin.mjs" });
    expect(manifest.dependencies).toEqual({ "playwright-core": "1.2.3", diff: "1.2.3" });
    expect(manifest.engines).toEqual({ node: ">=24.10" });
    expect(manifest.coxDesktop).toEqual({ protocol: 1, nodeVersion: "26.12.1" });
    expect(manifest.scripts).toEqual({ postinstall: "node postinstall.mjs" });
    expect(manifest.publishConfig.access).toBe("public");
  });

  it("rejects mismatched versions and tags before creating an artifact", async () => {
    const { pack, write } = await fixture();
    expect(() => pack("v9.9.9")).toThrow(/release tag must match/);
    await write("package.json", '{"version":"0.2.0"}');
    expect(() => pack()).toThrow(/release versions must agree/);
  });

  it("ships runtime patches and rejects patch versions that have drifted", async () => {
    const { root, pack, write } = await fixture();
    await write(
      "pnpm-workspace.yaml",
      "patchedDependencies:\n  playwright-core@1.2.3: patches/playwright-core.patch\n",
    );
    await write("patches/playwright-core.patch", "fixture patch\n");
    pack();
    const manifest = JSON.parse(
      await readFile(join(root, "release/npm/patches/manifest.json"), "utf8"),
    );
    expect(manifest).toEqual([
      { name: "playwright-core", version: "1.2.3", file: "playwright-core.patch" },
    ]);
    await write(
      "pnpm-workspace.yaml",
      "patchedDependencies:\n  playwright-core@9.9.9: patches/playwright-core.patch\n",
    );
    expect(() => pack()).toThrow(/does not match the installed version/);
  });
});

async function patchFixture() {
  const root = await mkdtemp(join(tmpdir(), "cox-npm-patch-test-"));
  temporaryDirectories.push(root);
  const dependency = join(root, "node_modules/fixture-dependency");
  await mkdir(dependency, { recursive: true });
  await mkdir(join(root, "patches"));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  await writeFile(
    join(dependency, "package.json"),
    '{"name":"fixture-dependency","version":"1.0.0"}',
  );
  await writeFile(join(dependency, "index.js"), "original\n");
  await symlink(dirname(require.resolve("diff/package.json")), join(root, "node_modules/diff"));
  await cp(join(source, "scripts/npm-postinstall.mjs"), join(root, "postinstall.mjs"));
  await writeFile(
    join(root, "patches/manifest.json"),
    JSON.stringify([{ name: "fixture-dependency", version: "1.0.0", file: "fixture.patch" }]),
  );
  await writeFile(
    join(root, "patches/fixture.patch"),
    "--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-original\n+patched\n",
  );
  const install = () =>
    execFileSync(process.execPath, ["postinstall.mjs"], { cwd: root, stdio: "pipe" });
  return { root, dependency, install };
}

describe("npm runtime patches", () => {
  it("applies patches idempotently", async () => {
    const { dependency, install } = await patchFixture();
    install();
    install();
    expect(await readFile(join(dependency, "index.js"), "utf8")).toBe("patched\n");
  });

  it("rejects wrong versions and unexpected dependency contents", async () => {
    const { dependency, install } = await patchFixture();
    await writeFile(join(dependency, "index.js"), "unexpected\n");
    expect(install).toThrow(/Cannot apply/);
    await writeFile(join(dependency, "package.json"), '{"version":"2.0.0"}');
    expect(install).toThrow(/expected 1.0.0, got 2.0.0/);
  });

  it("rejects symlinks escaping the dependency", async () => {
    const { root, dependency, install } = await patchFixture();
    const outside = join(root, "outside.js");
    await writeFile(outside, "original\n");
    await rm(join(dependency, "index.js"));
    await symlink(outside, join(dependency, "index.js"));
    expect(install).toThrow(/must stay inside the dependency/);
    expect(await readFile(outside, "utf8")).toBe("original\n");
  });
});

interface PublishWorkflow {
  on: {
    workflow_dispatch: {
      inputs: { authentication: { default: string; options: string[] } };
    };
  };
  jobs: {
    publish: {
      permissions: { "id-token": string };
      steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>;
    };
  };
}

async function authenticationFixture() {
  const workflow = parse(
    await readFile(join(source, ".github/workflows/npm-publish.yml"), "utf8"),
  ) as PublishWorkflow;
  const step = workflow.jobs.publish.steps.find(
    (entry) => entry.name === "Check npm publishing authentication",
  );
  if (!step?.run) throw new Error("Missing npm authentication check");
  const script = step.run;
  const root = await mkdtemp(join(tmpdir(), "cox-npm-auth-test-"));
  temporaryDirectories.push(root);
  const npm = join(root, "npm");
  await writeFile(
    npm,
    '#!/bin/bash\nprintf "%s\\n" "$*" >> "$RUNNER_TEMP/npm-calls"\nexit "${NPM_TEST_STATUS:-0}"\n',
  );
  await chmod(npm, 0o755);
  const check = (env: Record<string, string> = {}) =>
    execFileSync("bash", ["-c", script], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RUNNER_TEMP: root,
        GITHUB_ENV: join(root, "github-env"),
        NPM_PUBLISH_AUTH: "oidc",
        NODE_AUTH_TOKEN: "",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid/oidc",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture-oidc-request",
        ...env,
      },
      encoding: "utf8",
      stdio: "pipe",
    });
  return { root, workflow, step, check };
}

describe("npm publishing authentication", () => {
  it("defaults to OIDC and only exposes the bootstrap secret in explicit token mode", async () => {
    const { workflow, step } = await authenticationFixture();
    expect(workflow.on.workflow_dispatch.inputs.authentication).toMatchObject({
      default: "oidc",
      options: ["oidc", "token"],
    });
    expect(workflow.jobs.publish.permissions["id-token"]).toBe("write");
    const publish = workflow.jobs.publish.steps.find((entry) => entry.name === "Publish to npm");
    const token = "${{ inputs.authentication == 'token' && secrets.NPM_TOKEN || '' }}";
    expect(step.env?.NODE_AUTH_TOKEN).toBe(token);
    expect(publish?.env?.NODE_AUTH_TOKEN).toBe(token);
    expect(workflow.jobs.publish.steps.indexOf(step)).toBeLessThan(
      workflow.jobs.publish.steps.findIndex((entry) => entry.run === "pnpm release:npm"),
    );
  });

  it("keeps OIDC registry configuration token-free even with an inherited token", async () => {
    const { root, check } = await authenticationFixture();
    check({ NODE_AUTH_TOKEN: "fixture-unused-token" });
    expect(await readFile(join(root, "cox-publish.npmrc"), "utf8")).toBe(
      "registry=https://registry.npmjs.org/\n",
    );
    expect(await readFile(join(root, "npm-calls"), "utf8")).toBe("view @doublepi123/cox version\n");
    expect(await readFile(join(root, "github-env"), "utf8")).toContain(
      `NPM_CONFIG_USERCONFIG=${root}/cox-publish.npmrc`,
    );
  });

  it("explains the bootstrap path when the package cannot be read", async () => {
    const { check } = await authenticationFixture();
    expect(() => check({ NPM_TEST_STATUS: "1" })).toThrow(/authentication=token first/);
  });

  it("rejects OIDC without GitHub's token request permissions", async () => {
    const { check } = await authenticationFixture();
    expect(() => check({ ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" })).toThrow(/id-token: write/);
  });

  it("rejects missing or expired bootstrap tokens", async () => {
    const { check } = await authenticationFixture();
    expect(() => check({ NPM_PUBLISH_AUTH: "token" })).toThrow(/NPM_TOKEN repository secret/);
    expect(() =>
      check({ NPM_PUBLISH_AUTH: "token", NODE_AUTH_TOKEN: "fixture-token", NPM_TEST_STATUS: "1" }),
    ).toThrow(/invalid or expired/);
  });

  it("checks explicit token authentication without writing the secret into the config", async () => {
    const { root, check } = await authenticationFixture();
    check({ NPM_PUBLISH_AUTH: "token", NODE_AUTH_TOKEN: "fixture-token" });
    expect(await readFile(join(root, "npm-calls"), "utf8")).toBe("whoami\n");
    expect(await readFile(join(root, "cox-publish.npmrc"), "utf8")).toBe(
      "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
    );
  });

  it("rejects unknown authentication modes", async () => {
    const { check } = await authenticationFixture();
    expect(() => check({ NPM_PUBLISH_AUTH: "unexpected" })).toThrow(/Unknown npm publishing/);
  });
});
