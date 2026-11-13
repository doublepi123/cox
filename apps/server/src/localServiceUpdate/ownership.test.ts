// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DatabaseMigrationHead from "../persistence/databaseMigrationHead.ts";
import { make as makeLocalServiceUpdate } from "./LocalServiceUpdate.ts";
import {
  compareVersions,
  detectLocalServiceUpdateOwnership,
  LOCAL_SERVICE_UPDATE_ENV,
  updateEnvironment,
} from "./ownership.ts";
import * as Operation from "./operation.ts";
import * as Preflight from "./preflight.ts";
import * as Release from "./release.ts";
import { parseLocalServiceRelease } from "./release.ts";
import {
  localServiceReceiptState,
  prepareLocalServiceUpdate,
  type LocalServiceUpdateReceipt,
  type LocalServiceUpdatePlan,
} from "./operation.ts";

const mocks = vi.hoisted(() => ({
  fetchRelease: vi.fn<typeof Release.fetchLocalServiceRelease>(),
  installRelease: vi.fn<typeof Release.installLocalServiceRelease>(),
  launchUpdate: vi.fn<typeof Operation.launchLocalServiceUpdate>(),
  inspectCandidateMigration: vi.fn<typeof Preflight.inspectCandidateMigration>(),
  databaseMigrationHead: vi.fn<typeof DatabaseMigrationHead.databaseMigrationHead>(),
}));

vi.mock("./release.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchLocalServiceRelease: mocks.fetchRelease,
  installLocalServiceRelease: mocks.installRelease,
}));
vi.mock("./operation.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  launchLocalServiceUpdate: mocks.launchUpdate,
}));
vi.mock("./preflight.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  inspectCandidateMigration: mocks.inspectCandidateMigration,
}));
vi.mock("../persistence/databaseMigrationHead.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  databaseMigrationHead: mocks.databaseMigrationHead,
}));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function receipt(
  status: LocalServiceUpdateReceipt["status"],
  message: string | null = null,
): LocalServiceUpdateReceipt {
  return {
    schema: 1,
    targetVersion: "0.2.0",
    status,
    message,
    backupDirectory: "/private/backup",
    databaseBackup: "/private/backup/statev2.sqlite",
  };
}

async function writeReceipt(directory: string, value: LocalServiceUpdateReceipt) {
  await writeFile(join(directory, "local-service-update", "receipt.json"), JSON.stringify(value));
}

async function makeActivationPlan(entryContents: string | null, withDatabaseBackup: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "cox-local-service-update-activation-"));
  directories.push(directory);
  const baseDir = join(directory, "home");
  const operation = join(directory, "operation");
  const entry = join(directory, "candidate", "dist", "bin.mjs");
  await mkdir(join(baseDir, "local-service-update"), { recursive: true });
  await mkdir(join(operation, "backup"), { recursive: true });
  await writeFile(join(baseDir, "local-service-update", "unit"), "original unit\n");
  await writeFile(join(operation, "previous-unit"), "original unit\n");
  if (entryContents !== null) {
    await mkdir(join(directory, "candidate", "dist"), { recursive: true });
    await writeFile(entry, entryContents);
  }
  if (withDatabaseBackup) await writeFile(join(operation, "backup", "statev2.sqlite"), "preserved");
  return {
    schema: 1,
    fromVersion: "0.1.58",
    targetVersion: "0.2.0",
    pid: 123,
    serviceUnit: "cox.service",
    node: "/opt/node/bin/node",
    entry,
    packageRoot: "/srv/cox",
    baseDir,
    stateDir: join(directory, "userdata"),
    databasePath: join(directory, "userdata", "statev2.sqlite"),
    runtimeStatePath: join(directory, "userdata", "server-runtime.json"),
    environmentId: "environment-1",
    operation,
    nextUnit: "__COX_ENTRY__\n",
  } satisfies LocalServiceUpdatePlan;
}

async function makeService(initialReceipt?: LocalServiceUpdateReceipt) {
  const directory = await mkdtemp(join(tmpdir(), "cox-local-service-update-service-"));
  directories.push(directory);
  await mkdir(join(directory, "local-service-update"), { recursive: true });
  await writeFile(join(directory, "local-service-update", "unit"), "__COX_ENTRY__\n");
  if (initialReceipt) await writeReceipt(directory, initialReceipt);
  mocks.fetchRelease.mockResolvedValue({
    version: "99.0.0",
    url: "https://registry.npmjs.org/@doublepi123/cox/-/cox-99.0.0.tgz",
    integrity: "sha512-" + "A".repeat(86) + "==",
  });
  mocks.installRelease.mockImplementation(async (input) => {
    const current = join(input.directory, "current");
    await mkdir(join(current, "dist", "persistence"), { recursive: true });
    await writeFile(
      join(current, "package.json"),
      JSON.stringify({ version: input.release.version }),
    );
    return join(current, "dist", "bin.mjs");
  });
  mocks.launchUpdate.mockResolvedValue();
  mocks.inspectCandidateMigration.mockResolvedValue(1);
  mocks.databaseMigrationHead.mockReturnValue(1);
  const originalEntry = process.argv[1];
  const originalUpdateEnvironment = process.env[LOCAL_SERVICE_UPDATE_ENV];
  const originalInvocationId = process.env.INVOCATION_ID;
  process.argv[1] = "/srv/cox/dist/bin.mjs";
  process.env[LOCAL_SERVICE_UPDATE_ENV] = "1";
  process.env.INVOCATION_ID = "test-invocation";
  const dependencies = Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), directory).pipe(Layer.provide(NodeServices.layer)),
    NodeServices.layer,
    NodeSqliteClient.layer({ filename: ":memory:" }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("test-environment")),
    }),
  );
  const runtime = ManagedRuntime.make(dependencies);
  const config = await runtime.runPromise(ServerConfig.ServerConfig);
  const database = new DatabaseSync(config.dbPath);
  database.close();
  const service = await runtime.runPromise(
    makeLocalServiceUpdate().pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        ...config,
        staticDir: "/srv/cox/dist/client",
      }),
    ),
  );
  await runtime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, deleted_at INTEGER)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (thread_id TEXT, status TEXT)`;
    }),
  );
  return {
    directory,
    runtime,
    service,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      if (originalEntry === undefined) process.argv.splice(1, 1);
      else process.argv[1] = originalEntry;
      if (originalUpdateEnvironment === undefined) delete process.env[LOCAL_SERVICE_UPDATE_ENV];
      else process.env[LOCAL_SERVICE_UPDATE_ENV] = originalUpdateEnvironment;
      if (originalInvocationId === undefined) delete process.env.INVOCATION_ID;
      else process.env.INVOCATION_ID = originalInvocationId;
    },
  };
}

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
  it("consumes a rollback receipt so a fresh release can be downloaded", async () => {
    await using harness = await makeService(receipt("rolled-back", "health check failed"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "error",
    });
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "idle",
    });
    expect(await harness.runtime.runPromise(harness.service.check)).toMatchObject({
      status: "available",
      latestVersion: "99.0.0",
    });
    expect(await harness.runtime.runPromise(harness.service.download)).toMatchObject({
      status: "ready",
      latestVersion: "99.0.0",
    });
  });

  it("observes an activating receipt become healthy without inventing an applicable plan", async () => {
    await using harness = await makeService(receipt("activating"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "restarting",
    });
    await expect(harness.runtime.runPromise(harness.service.apply)).rejects.toThrow("not ready");
    await writeReceipt(harness.directory, receipt("healthy"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "idle",
    });
  });

  it("observes an activating receipt become a rollback error", async () => {
    await using harness = await makeService(receipt("activating"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "restarting",
    });
    await writeReceipt(harness.directory, receipt("rolled-back", "health check failed"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "error",
      message: expect.stringContaining("health check failed"),
    });
  });

  it("retains ready feedback during active work and observes recovery after apply", async () => {
    await using harness = await makeService();
    await harness.runtime.runPromise(harness.service.state);
    expect(await harness.runtime.runPromise(harness.service.download)).toMatchObject({
      status: "ready",
    });
    await harness.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, deleted_at) VALUES ('thread-1', NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (thread_id, status) VALUES ('thread-1', 'running')`;
      }),
    );
    expect(await harness.runtime.runPromise(harness.service.apply)).toMatchObject({
      status: "ready",
      message: expect.stringContaining("Wait for active agent turns"),
    });
    await harness.runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM orchestration_v2_projection_runs`;
      }),
    );
    expect(await harness.runtime.runPromise(harness.service.apply)).toMatchObject({
      status: "restarting",
      message: null,
    });
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "restarting",
      message: null,
    });
    await writeReceipt(harness.directory, receipt("healthy"));
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "idle",
    });
  });

  it("returns a launch failure and allows a fresh apply retry", async () => {
    await using harness = await makeService();
    await harness.runtime.runPromise(harness.service.state);
    expect(await harness.runtime.runPromise(harness.service.download)).toMatchObject({
      status: "ready",
    });
    mocks.launchUpdate.mockRejectedValueOnce(new Error("launch denied"));
    expect(await harness.runtime.runPromise(harness.service.apply)).toMatchObject({
      status: "error",
      message: expect.stringContaining("launch denied"),
    });
    expect(await harness.runtime.runPromise(harness.service.state)).toMatchObject({
      status: "error",
      message: expect.stringContaining("launch denied"),
    });
    expect(await harness.runtime.runPromise(harness.service.apply)).toMatchObject({
      status: "restarting",
      message: null,
    });
  });

  it("records invalid staged entrypoints without replacing the healthy service", async () => {
    const plan = await makeActivationPlan("invalid entrypoint\n", true);
    await expect(Operation.activateLocalServiceUpdate(plan)).resolves.toBeUndefined();
    expect(
      await Operation.readLocalServiceReceipt(
        join(plan.baseDir, "local-service-update", "receipt.json"),
      ),
    ).toMatchObject({
      status: "rolled-back",
      message: expect.stringContaining("entrypoint is invalid"),
    });
    expect(
      await Operation.readLocalServiceReceipt(join(plan.operation, "receipt.json")),
    ).toMatchObject({
      status: "rolled-back",
    });
    expect(await readFile(join(plan.baseDir, "local-service-update", "unit"), "utf8")).toBe(
      "original unit\n",
    );
    expect(await readFile(join(plan.operation, "backup", "statev2.sqlite"), "utf8")).toBe(
      "preserved",
    );
  });

  it("records a missing database backup without replacing the healthy service", async () => {
    const plan = await makeActivationPlan("#!/usr/bin/env node\n", false);
    await expect(Operation.activateLocalServiceUpdate(plan)).resolves.toBeUndefined();
    expect(
      await Operation.readLocalServiceReceipt(
        join(plan.baseDir, "local-service-update", "receipt.json"),
      ),
    ).toMatchObject({
      status: "rolled-back",
      message: expect.stringContaining("statev2.sqlite"),
    });
    expect(await readFile(join(plan.baseDir, "local-service-update", "unit"), "utf8")).toBe(
      "original unit\n",
    );
  });

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
