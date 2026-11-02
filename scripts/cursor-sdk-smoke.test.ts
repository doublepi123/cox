import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const directories: string[] = [];

async function probe(sdk: string) {
  const directory = await mkdtemp(join(tmpdir(), "cox-cursor-smoke-test-"));
  directories.push(directory);
  const sdkDirectory = join(directory, "node_modules/@cursor/sdk");
  await mkdir(sdkDirectory, { recursive: true });
  await writeFile(join(sdkDirectory, "index.js"), sdk);
  const script = join(directory, "cursor-sdk-smoke.cjs");
  await cp(join(import.meta.dirname, "cursor-sdk-smoke.cjs"), script);
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, HOME: directory },
  });
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Cursor SDK smoke", () => {
  it("prewarms sandbox and full access, releases resources, and isolates settings", async () => {
    const result = await probe(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      let released = 0;
      exports.createAgentPlatform = async ({ workspaceRef }) => {
        assert.equal(workspaceRef, process.cwd());
        assert.equal(workspaceRef, process.env.HOME);
        assert.ok(fs.existsSync(workspaceRef));
        return { prewarmLocalWorkspace: async ({ local }) => {
          assert.equal(local.cwd, workspaceRef);
          assert.deepEqual(local.settingSources, []);
          assert.equal(local.sandboxOptions.enabled, [true, false, true][released]);
          return async () => { released++; };
        }};
      };
      process.on('exit', () => {
        assert.equal(released, 3);
        assert.equal(fs.existsSync(process.env.HOME), false);
      });
    `);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout.match(/Cursor SDK prewarm ok/g)).toHaveLength(3);
  });

  it.each(["require", "platform", "prewarm", "release"])(
    "fails on the original %s error",
    async (stage) => {
      const failure = "throw new Error('native-loader-first-failure')";
      const result = await probe(`
      ${stage === "require" ? failure : ""}
      exports.createAgentPlatform = async () => {
        ${stage === "platform" ? failure : ""}
        return { prewarmLocalWorkspace: async () => {
          ${stage === "prewarm" ? failure : ""}
          return async () => { ${stage === "release" ? failure : ""} };
        }};
      };
    `);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("native-loader-first-failure");
      expect(result.stdout).not.toContain("Cursor SDK prewarm ok");
    },
  );

  it("runs the SDK smoke against the npm installation before server startup", async () => {
    const script = await readFile(
      join(import.meta.dirname, "../.github/workflows/npm-publish.yml"),
      "utf8",
    );
    const install = 'npm install --prefix "$prefix" --no-audit --no-fund "$package"';
    const copy =
      'cp scripts/cursor-sdk-smoke.cjs "$prefix/node_modules/@doublepi123/cox/cursor-sdk-smoke.cjs"';
    const smoke = 'timeout 90 node "$prefix/node_modules/@doublepi123/cox/cursor-sdk-smoke.cjs"';
    const server =
      'node scripts/runtime-smoke.mjs "$prefix/node_modules/@doublepi123/cox/dist/bin.mjs"';
    for (const command of [install, copy, smoke, server]) expect(script).toContain(command);
    expect(script.indexOf(install)).toBeLessThan(script.indexOf(copy));
    expect(script.indexOf(copy)).toBeLessThan(script.indexOf(smoke));
    expect(script.indexOf(smoke)).toBeLessThan(script.indexOf(server));
  });
});
