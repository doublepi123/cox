// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  compareVersions,
  detectLocalServiceUpdateOwnership,
  updateEnvironment,
} from "./ownership.ts";
import { parseLocalServiceRelease } from "./release.ts";
import {
  localServiceReceiptState,
  prepareLocalServiceUpdate,
  type LocalServiceUpdatePlan,
} from "./operation.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function ownership(overrides: Record<string, unknown> = {}) {
  return detectLocalServiceUpdateOwnership({
    enabled: true,
    environment: "1",
    platform: "linux",
    execPath: "/opt/node/bin/node",
    entryPath: "/srv/cox/dist/bin.mjs",
    staticDir: "/srv/cox/dist/client",
    invocationId: "test-invocation",
    realpath: (path) => path,
    ...overrides,
  } as Parameters<typeof detectLocalServiceUpdateOwnership>[0]);
}

describe("local service update boundaries", () => {
  it("requires explicit ownership and the production systemd/npm process shape", () => {
    expect(ownership()?.packageRoot).toBe("/srv/cox");
    expect(ownership({ environment: undefined })).toBeNull();
    expect(ownership({ invocationId: undefined })).toBeNull();
    expect(ownership({ enabled: false })).toBeNull();
    expect(ownership({ platform: "darwin" })).toBeNull();
    expect(ownership({ entryPath: "/home/user/code/cox/apps/server/src/bin.ts" })).toBeNull();
    expect(ownership({ staticDir: "/tmp/other-client" })).toBeNull();
    expect(ownership({ staticDir: "/tmp/other-client" })).toBeNull();
  });

  it("orders only exact stable releases and filters inherited service overrides", () => {
    expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
    expect(compareVersions("0.1.58", "0.1.58")).toBe(0);
    expect(compareVersions("0.1.58", "0.2.0")).toBe(-1);
    expect(() => compareVersions("latest", "0.1.58")).toThrow();
    const environment = updateEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/test",
      COX_AUTH_PASSWORD: "must-not-leak",
      COX_HOME: "/tmp/other",
      NODE_OPTIONS: "--import=untrusted",
      HTTP_PROXY: "http://proxy.test",
    });
    expect(environment).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/test",
      HTTP_PROXY: "http://proxy.test",
    });
  });

  it("accepts only the official immutable stable package with a SHA-512 integrity", () => {
    const release = {
      name: "@doublepi123/cox",
      version: "0.2.0",
      dist: {
        tarball: "https://registry.npmjs.org/@doublepi123/cox/-/cox-0.2.0.tgz",
        integrity: "sha512-" + "A".repeat(86) + "==",
      },
    };
    expect(parseLocalServiceRelease(release).version).toBe("0.2.0");
    for (const change of [
      { version: "latest" },
      { version: "0.2.0-beta.1" },
      { name: "cox" },
      { dist: { ...release.dist, tarball: "https://example.com/cox.tgz" } },
      { dist: { ...release.dist, integrity: "sha256-untrusted" } },
    ])
      expect(() => parseLocalServiceRelease({ ...release, ...change })).toThrow();
  });
});

describe("local service update transaction", () => {
  it("backs up a consistent live SQLite database and static settings before handoff", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-local-service-update-"));
    directories.push(directory);
    const stateDir = join(directory, "userdata");
    const databasePath = join(stateDir, "statev2.sqlite");
    const baseDir = join(directory, "home");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(baseDir, "local-service-update"), { recursive: true }),
    );
    await import("node:fs/promises").then(({ mkdir }) => mkdir(stateDir, { recursive: true }));
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('preserved')");
    database.close();
    await writeFile(join(stateDir, "settings.json"), '{"theme":"dark"}\n');
    await writeFile(join(baseDir, "local-service-update", "unit"), "original unit\n");
    const plan: LocalServiceUpdatePlan = {
      schema: 1,
      fromVersion: "0.1.58",
      targetVersion: "0.2.0",
      pid: 123,
      serviceUnit: "cox.service",
      node: "/opt/node/bin/node",
      entry: join(directory, "candidate", "dist", "bin.mjs"),
      packageRoot: "/srv/cox",
      baseDir,
      stateDir,
      databasePath,
      runtimeStatePath: join(stateDir, "server-runtime.json"),
      environmentId: "environment-1",
      operation: join(directory, "operation"),
      nextUnit: "updated unit\n",
    };
    await prepareLocalServiceUpdate(plan);
    const backup = new DatabaseSync(join(plan.operation, "backup", "statev2.sqlite"), {
      readOnly: true,
    });
    expect(backup.prepare("SELECT value FROM example").get()).toEqual({ value: "preserved" });
    backup.close();
    expect(await readFile(join(plan.operation, "backup", "settings.json"), "utf8")).toContain(
      "dark",
    );
    expect(await readFile(join(plan.operation, "previous-unit"), "utf8")).toBe("original unit\n");
    expect(JSON.parse(await readFile(join(plan.operation, "plan.json"), "utf8"))).toMatchObject({
      targetVersion: "0.2.0",
      serviceUnit: "cox.service",
    });
  });

  it("retains rollback evidence without presenting a restored version as an available update", () => {
    const state = localServiceReceiptState("0.1.58", {
      schema: 1,
      targetVersion: "0.2.0",
      status: "rolled-back",
      message: "health check failed",
      backupDirectory: "/private/backup",
      databaseBackup: "/private/backup/statev2.sqlite",
    });
    expect(state).toMatchObject({
      supported: true,
      currentVersion: "0.1.58",
      status: "error",
      backup: { directory: "/private/backup" },
    });
    expect(state.message).toContain("restored");
    expect(localServiceReceiptState("0.2.0", null).status).toBe("idle");
  });

  it("hashes release bytes independently of their metadata", () => {
    const release = {
      name: "@doublepi123/cox",
      version: "0.2.0",
      dist: {
        tarball: "https://registry.npmjs.org/@doublepi123/cox/-/cox-0.2.0.tgz",
        integrity: "sha512-" + createHash("sha512").update("package").digest("base64"),
      },
    };
    expect(parseLocalServiceRelease(release).integrity).toBe(release.dist.integrity);
  });
});
