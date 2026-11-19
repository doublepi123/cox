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
import * as Schedule from "effect/Schedule";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerConfig from "../config.ts";
import { databaseMigrationHead } from "../persistence/databaseMigrationHead.ts";
import { inspectCandidateMigration } from "./preflight.ts";
import {
  compareVersions,
  detectLocalServiceUpdateOwnership,
  supportsNpmCoxUpdates,
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
  renderLocalServiceDropIn,
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
  const supported = supportsNpmCoxUpdates(config);
  const ownership: LocalServiceUpdateOwnership | null = supported
    ? yield* Effect.tryPromise(detectLocalServiceUpdateOwnership).pipe(
        Effect.orElseSucceed(() => null),
      )
    : null;
  let current = !supported
    ? unavailable()
    : {
        ...localServiceReceiptState(packageJson.version, null),
        ...(!ownership && { checkOnly: true }),
      };
  let ready = false;
  let operation: Promise<void> | undefined;
  let release: LocalServiceRelease | undefined;
  let plan: LocalServiceUpdatePlan | undefined;
  let consumedReceipt:
    | { readonly key: string; readonly state: LocalServiceUpdateState }
    | undefined;
  const directory = path.join(config.baseDir, "local-service-update");
  const receiptPath = path.join(directory, "receipt.json");
  const run = Effect.runPromiseWith(yield* Effect.context<FileSystem.FileSystem | Crypto.Crypto>());

  const state: Effect.Effect<LocalServiceUpdateState> = Effect.gen(function* () {
    if (!ownership) return current;
    if (operation) return current;
    if (current.status === "downloading" || (current.status === "ready" && ready && plan))
      return current;
    const receipt = yield* Effect.tryPromise(() => readLocalServiceReceipt(receiptPath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (!receipt) {
      consumedReceipt = undefined;
      if (current.supported && (current.status !== "restarting" || plan)) return current;
      current = localServiceReceiptState(packageJson.version, null);
      return current;
    }
    if (receipt.status === "activating") {
      consumedReceipt = undefined;
      current = localServiceReceiptState(packageJson.version, receipt);
      return current;
    }
    const key = [
      receipt.status,
      receipt.targetVersion,
      receipt.message,
      receipt.backupDirectory,
      receipt.databaseBackup,
    ].join("\0");
    if (consumedReceipt?.key === key && current !== consumedReceipt.state) return current;
    current = localServiceReceiptState(
      packageJson.version,
      consumedReceipt?.key === key ? null : receipt,
    );
    consumedReceipt = { key, state: current };
    return current;
  }).pipe(Effect.withSpan("localServiceUpdate.state"));

  const checkRelease = Effect.fn("localServiceUpdate.check")(function* (automatic: boolean) {
    if (!supported) return yield* state;
    if (operation) {
      yield* Effect.promise(async () => operation);
      return yield* state;
    }
    if (automatic) {
      yield* state;
      if (operation || (current.status !== "idle" && current.status !== "available"))
        return current;
    }
    if (current.status === "restarting" || (current.status === "ready" && ready)) return current;
    const previous = current;
    current = { ...current, status: "checking", message: null, progress: null };
    const pending = (async () => {
      try {
        release = await fetchLocalServiceRelease(AbortSignal.timeout(30_000));
        current = {
          ...current,
          latestVersion: release.version,
          status: compareVersions(release.version, packageJson.version) > 0 ? "available" : "idle",
        };
      } catch (error) {
        current = automatic
          ? previous
          : { ...current, status: "error", message: String(error), progress: null };
      }
    })().finally(() => {
      if (operation === pending) operation = undefined;
    });
    operation = pending;
    yield* Effect.promise(() => pending);
    return yield* state;
  });
  const check = checkRelease(false);
  const checkPeriodically = supported
    ? checkRelease(true).pipe(Effect.repeat(Schedule.spaced("1 hour")), Effect.asVoid)
    : Effect.void;

  const download: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError> = Effect.gen(
    function* () {
      if (!ownership) return yield* state;
      if (operation) {
        yield* Effect.promise(async () => operation);
        return yield* state;
      }
      if (current.status === "restarting" || (current.status === "ready" && ready && plan))
        return current;
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
      const pending = (async () => {
        try {
          const candidates = path.join(directory, "candidates");
          const { mkdir, mkdtemp } = await import("node:fs/promises");
          await mkdir(candidates, { recursive: true, mode: 0o700 });
          const target = await mkdtemp(path.join(candidates, selected.version + "-"));
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
          await run(
            Effect.gen(function* () {
              const actual = yield* Effect.sync(() => databaseMigrationHead(config.dbPath));
              if (actual === undefined)
                return yield* Effect.fail("The live database migration history is unreadable.");
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
            dropIn: ownership.dropIn,
            baseDir: config.baseDir,
            stateDir: config.stateDir,
            databasePath: config.dbPath,
            runtimeStatePath: config.serverRuntimeStatePath,
            environmentId,
            operation: path.join(directory, "operations", suffix),
            nextUnit: renderLocalServiceDropIn([
              ownership.node,
              ...ownership.argsBeforeEntry,
              entry,
              ...ownership.argsAfterEntry,
            ]),
          };
          await prepareLocalServiceUpdate(preparedPlan);
          plan = preparedPlan;
          ready = true;
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
      })().finally(() => {
        if (operation === pending) operation = undefined;
      });
      operation = pending;
      yield* Effect.promise(() => pending);
      return current;
    },
  ).pipe(Effect.withSpan("localServiceUpdate.download"));

  const apply: Effect.Effect<LocalServiceUpdateState, LocalServiceUpdateError> = Effect.gen(
    function* () {
      if (!ownership) return yield* state;
      if (current.status === "restarting" && plan) return current;
      if (!["ready", "error"].includes(current.status) || !ready || !plan || operation)
        return yield* Effect.fail(new LocalServiceUpdateError("The Cox update is not ready."));
      const active = yield* busyWork(sql).pipe(
        Effect.mapError((cause) => new LocalServiceUpdateError(String(cause))),
      );
      if (active.length > 0) {
        current = {
          ...current,
          status: "ready",
          message: "Wait for active agent turns to finish before updating Cox.",
          progress: null,
        };
        return current;
      }
      current = { ...current, status: "restarting", message: null, progress: null };
      ready = false;
      const launched = launchLocalServiceUpdate(plan)
        .catch((error: unknown) => {
          ready = true;
          current = { ...current, status: "error", message: String(error), progress: null };
        })
        .finally(() => {
          if (operation === launched) operation = undefined;
        });
      operation = launched;
      yield* Effect.promise(() => launched);
      return current;
    },
  ).pipe(Effect.withSpan("localServiceUpdate.apply"));

  return { ...LocalServiceUpdate.of({ state, check, download, apply }), checkPeriodically };
});

export const layer = Layer.effect(
  LocalServiceUpdate,
  Effect.gen(function* () {
    const updates = yield* make();
    yield* updates.checkPeriodically.pipe(Effect.forkScoped);
    return updates;
  }),
);
