import type { LocalServiceUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { databaseMigrationHead } from "../persistence/databaseMigrationHead.ts";
import { inspectCandidateMigration } from "./preflight.ts";
import {
  compareVersions,
  detectLocalServiceUpdateOwnership,
  LOCAL_SERVICE_UPDATE_ENV,
  updateEnvironment,
  type LocalServiceUpdateOwnership,
} from "./ownership.ts";
import {
  fetchLocalServiceRelease,
  installLocalServiceRelease,
  type LocalServiceRelease,
} from "./release.ts";
import {
  launchLocalServiceUpdate,
  localServiceReceiptState,
  prepareLocalServiceUpdate,
  readLocalServiceReceipt,
  type LocalServiceUpdatePlan,
} from "./operation.ts";

const decodePackageManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

export class LocalServiceUpdateError extends Error {
  readonly _tag = "LocalServiceUpdateError";
}

export class LocalServiceUpdate extends Context.Service<
  LocalServiceUpdate,
  {
    readonly state: Effect.Effect<LocalServiceUpdateState>;
    readonly check: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError>;
    readonly download: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError>;
    readonly apply: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError>;
  }
>()("cox/localServiceUpdate/LocalServiceUpdate") {}

const unavailable = (): LocalServiceUpdateState => ({
  supported: false,
  currentVersion: packageJson.version,
  latestVersion: null,
  status: "unavailable",
  message: null,
  progress: null,
  backup: null,
});

const busyWork = (sql: SqlClient.SqlClient) => sql<{ readonly thread_id: string }>`
  SELECT thread_id FROM orchestration_v2_projection_threads t
  WHERE deleted_at IS NULL AND (
    EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting'))
    OR EXISTS (SELECT 1 FROM orchestration_v2_projection_runtime_requests request WHERE request.thread_id = t.thread_id AND request.status = 'pending')
  ) LIMIT 1
`;

export const make = Effect.fn("localServiceUpdate.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const ownership: LocalServiceUpdateOwnership | null = detectLocalServiceUpdateOwnership({
    enabled: config.devUrl === undefined,
    ...(process.env[LOCAL_SERVICE_UPDATE_ENV]
      ? { environment: process.env[LOCAL_SERVICE_UPDATE_ENV] }
      : {}),
    platform: process.platform,
    execPath: process.execPath,
    ...(process.argv[1] ? { entryPath: process.argv[1] } : {}),
    ...(config.staticDir ? { staticDir: config.staticDir } : {}),
    ...(process.env.INVOCATION_ID ? { invocationId: process.env.INVOCATION_ID } : {}),
    realpath: (path) => path,
  });
  let current = unavailable();
  let ready = false;
  let operation: Promise<void> | undefined;
  let release: LocalServiceRelease | undefined;
  let plan: LocalServiceUpdatePlan | undefined;
  const directory = path.join(config.baseDir, "local-service-update");
  const receiptPath = path.join(directory, "receipt.json");
  const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Crypto.Crypto>());

  const state: Effect.Effect<LocalServiceUpdateState> = Effect.gen(function* () {
    if (!ownership) return unavailable();
    if (operation) return current;
    const receipt = yield* Effect.tryPromise(() => readLocalServiceReceipt(receiptPath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (current.supported && !receipt) return current;
    if (["downloading", "ready", "restarting"].includes(current.status)) return current;
    current = localServiceReceiptState(packageJson.version, receipt);
    return current;
  }).pipe(Effect.withSpan("localServiceUpdate.state"));

  const check: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError> = Effect.gen(
    function* () {
      if (!ownership) return yield* state;
      if (operation) {
        yield* Effect.promise(async () => operation);
        return yield* state;
      }
      if (["ready", "restarting"].includes(current.status) && ready) return current;
      current = { ...current, status: "checking", message: null, progress: null };
      operation = (async () => {
        try {
          release = await fetchLocalServiceRelease(AbortSignal.timeout(30_000));
          current = {
            ...current,
            latestVersion: release.version,
            status:
              compareVersions(release.version, packageJson.version) > 0 ? "available" : "idle",
          };
        } catch (error) {
          current = { ...current, status: "error", message: String(error), progress: null };
        }
      })();
      try {
        yield* Effect.promise(async () => operation);
      } finally {
        operation = undefined;
      }
      return yield* state;
    },
  ).pipe(Effect.withSpan("localServiceUpdate.check"));

  const download: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError> = Effect.gen(
    function* () {
      if (!ownership) return yield* state;
      if (operation) {
        yield* Effect.promise(async () => operation);
        return yield* state;
      }
      if (current.status === "ready" && ready && plan) return current;
      if (!release || current.status !== "available") {
        yield* check;
        if (current.status !== "available" || !release) return current;
      }
      const selected = release;
      current = {
        ...current,
        status: "downloading",
        message: null,
        progress: {
          phase: "downloading",
          transferredBytes: 0,
          totalBytes: null,
          bytesPerSecond: null,
          remainingSeconds: null,
        },
      };
      operation = (async () => {
        try {
          const target = path.join(directory, "candidates", selected.version);
          const { mkdir, rm } = await import("node:fs/promises");
          await rm(target, { recursive: true, force: true });
          await mkdir(target, { recursive: true, mode: 0o700 });
          const entry = await installLocalServiceRelease({
            release: selected,
            directory: target,
            node: ownership.node,
            npm: ownership.npm,
            environment: updateEnvironment(process.env),
            onProgress: (progress) => {
              current = { ...current, progress };
            },
          });
          const inspected = await run(
            Effect.gen(function* () {
              const actual = yield* Effect.sync(() => databaseMigrationHead(config.dbPath));
              if (actual === undefined)
                return yield* Effect.fail("The live database migration history is unreadable.");
              const unit = yield* FileSystem.FileSystem.pipe(
                Effect.flatMap((fs) => fs.readFileString(path.join(directory, "unit"))),
              );
              if (!unit.includes("__COX_ENTRY__"))
                return yield* Effect.fail(
                  "The local Cox update unit must use the __COX_ENTRY__ placeholder.",
                );
              const manifest = yield* decodePackageManifest(
                yield* FileSystem.FileSystem.pipe(
                  Effect.flatMap((fs) =>
                    fs.readFileString(path.join(target, "current", "package.json")),
                  ),
                ),
              );
              if (manifest.version !== selected.version)
                return yield* Effect.fail("The installed Cox version does not match.");
              const targetHead = yield* Effect.promise(() =>
                inspectCandidateMigration(
                  path.join(target, "current", "dist", "persistence", "databaseMigrationHead.mjs"),
                  ownership.node,
                ),
              );
              if (targetHead < actual)
                return yield* Effect.fail(
                  "The update would downgrade the database schema. Use a manual backup and upgrade.",
                );
              if (targetHead !== actual)
                return yield* Effect.fail(
                  "The update would change the database schema. Use a manual backup and upgrade.",
                );
              return { unit };
            }).pipe(Effect.mapError((cause) => new LocalServiceUpdateError(String(cause)))),
          );
          const active = await run(
            busyWork(sql).pipe(
              Effect.mapError((cause) => new LocalServiceUpdateError(String(cause))),
            ),
          );
          if (active.length > 0)
            throw new Error("Wait for active agent turns to finish before updating Cox.");
          const suffix = await run(
            Effect.map(
              Effect.all([
                Clock.currentTimeMillis,
                Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4())),
              ]),
              ([time, id]) => `${time}-${id}`,
            ),
          );
          const preparedPlan: LocalServiceUpdatePlan = {
            schema: 1,
            fromVersion: packageJson.version,
            targetVersion: selected.version,
            pid: process.pid,
            serviceUnit: ownership.serviceUnit,
            node: ownership.node,
            entry,
            packageRoot: ownership.packageRoot,
            baseDir: config.baseDir,
            stateDir: config.stateDir,
            databasePath: config.dbPath,
            runtimeStatePath: config.serverRuntimeStatePath,
            environmentId,
            operation: path.join(directory, "operations", suffix),
            nextUnit: inspected.unit,
          };
          plan = preparedPlan;
          ready = true;
          await prepareLocalServiceUpdate(preparedPlan);
          const backupDirectory = path.join(preparedPlan.operation, "backup");
          current = {
            ...current,
            status: "ready",
            message: null,
            progress: null,
            backup: {
              directory: backupDirectory,
              database: path.join(backupDirectory, "statev2.sqlite"),
            },
          };
        } catch (error) {
          current = { ...current, status: "error", message: String(error), progress: null };
        }
      })();
      try {
        yield* Effect.promise(async () => operation);
      } finally {
        operation = undefined;
      }
      return current;
    },
  ).pipe(Effect.withSpan("localServiceUpdate.download"));

  const apply: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError> = Effect.gen(
    function* () {
      if (!ownership) return yield* state;
      if (current.status === "restarting" && plan) return current;
      if (current.status !== "ready" || !ready || !plan || operation)
        return yield* Effect.fail(new LocalServiceUpdateError("The Cox update is not ready."));
      const active = yield* busyWork(sql).pipe(
        Effect.mapError((cause) => new LocalServiceUpdateError(String(cause))),
      );
      if (active.length > 0)
        return yield* Effect.fail(
          new LocalServiceUpdateError("Wait for active agent turns to finish before updating Cox."),
        );
      current = { ...current, status: "restarting", message: null, progress: null };
      operation = launchLocalServiceUpdate(plan).catch((error: unknown) => {
        current = { ...current, status: "error", message: String(error), progress: null };
        throw error;
      });
      try {
        yield* Effect.promise(async () => operation);
      } finally {
        operation = undefined;
      }
      return current;
    },
  ).pipe(Effect.withSpan("localServiceUpdate.apply"));

  return LocalServiceUpdate.of({ state, check, download, apply });
});

export const layer = Layer.effect(LocalServiceUpdate, make());
