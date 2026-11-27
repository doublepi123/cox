import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Command } from "effect/cli";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";

import { doctorCommand, runDoctor } from "./doctor.ts";
import { DatabaseMaintenance } from "../persistence/DatabaseMaintenance.ts";

const layerHost = Layer.mergeAll(
  Layer.succeed(HostProcess.Environment, {}),
  Layer.succeed(HostProcess.WorkingDirectory, process.cwd()),
  Layer.succeed(HostProcess.HomeDirectory, process.cwd()),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

it.effect("doctor --dry-run leaves the data directory and uploads alone", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-doctor-dry-run-" });
    const stateDir = path.join(baseDir, "userdata");
    const attachmentsDir = path.join(stateDir, "attachments");
    const upload = path.join(attachmentsDir, "upload.part");
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    yield* fs.writeFileString(upload, "partial upload");
    yield* fs.utimes(upload, 0, 0);
    yield* TestClock.setTime(2 * 60 * 60 * 1_000);
    yield* SqlClient.SqlClient.pipe(
      Effect.flatMap((sql) => sql`CREATE TABLE fixture (id INTEGER)`),
      Effect.provide(NodeSqliteClient.layer({ filename: path.join(stateDir, "statev2.sqlite") })),
    );

    yield* Command.runWith(doctorCommand, { version: "0.0.0" })([
      "--base-dir",
      baseDir,
      "--fix",
      "--dry-run",
    ]).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: {
              COX_PORT: "3773",
              T3CODE_TRACE_FILE: path.join(baseDir, "trace", "trace.ndjson"),
            },
          }),
        ),
      ),
    );

    assert.isTrue(yield* fs.exists(upload));
    assert.deepEqual(yield* fs.readDirectory(baseDir), ["userdata"]);
    assert.deepEqual((yield* fs.readDirectory(stateDir)).toSorted(), [
      "attachments",
      "statev2.sqlite",
    ]);
  }).pipe(Effect.provide(Layer.mergeAll(layerHost, NetService.layer))),
);

it.effect("reports sizes just under the next unit in that unit", () =>
  Effect.gen(function* () {
    yield* runDoctor("/test/statev2.sqlite", { fix: false, dryRun: true }).pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(DatabaseMaintenance)({
            inspect: () =>
              Effect.succeed({
                databaseBytes: 1024 ** 3 - 4096,
                reclaimableBytes: 1024 ** 2 - 512,
                incrementalVacuumEnabled: true,
                legacyDatabaseBytes: null,
              }),
          }),
        ),
      ),
    );
    const [summary] = yield* TestConsole.logLines;
    assert.strictEqual(summary, "Database: 1.00 GiB, 1.0 MiB reclaimable.");
  }).pipe(Effect.provide(TestConsole.layer)),
);

it.effect("--fix reclaims space and keeps the V1 database, and --dry-run changes nothing", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const doctor = (dryRun: boolean) =>
      runDoctor("/test/statev2.sqlite", { fix: true, dryRun, interactive: false }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            Layer.succeed(DatabaseMaintenance, {
              inspect: () =>
                Effect.succeed({
                  databaseBytes: 2000,
                  reclaimableBytes: 1000,
                  incrementalVacuumEnabled: false,
                  legacyDatabaseBytes: 4000,
                }),
              compact: () =>
                Effect.sync(() => {
                  calls.push("compact");
                  return {
                    beforeBytes: 2000,
                    afterBytes: 1000,
                    deletedEventCount: 1,
                    deletedReceiptCount: 0,
                  };
                }),
              removeLegacyDatabase: () => Effect.sync(() => calls.push("remove legacy")),
            }),
          ),
        ),
      );
    yield* doctor(true);
    assert.deepEqual(calls, []);
    yield* doctor(false);
    assert.deepEqual(calls, ["compact"]);
  }),
);
