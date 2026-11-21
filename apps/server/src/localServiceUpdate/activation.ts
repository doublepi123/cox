// @effect-diagnostics nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { activateLocalServiceUpdate, type LocalServiceUpdatePlan } from "./operation.ts";
import { isLocalServiceUpdateUnit, stableVersion } from "./ownership.ts";

const Plan = Schema.Struct({
  schema: Schema.Literal(1),
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  serviceUnit: Schema.String,
  node: Schema.String,
  entry: Schema.String,
  dropIn: Schema.String,
  baseDir: Schema.String,
  stateDir: Schema.String,
  databasePath: Schema.String,
  backupDatabase: Schema.optionalKey(Schema.Boolean),
  runtimeStatePath: Schema.String,
  environmentId: Schema.String,
  operation: Schema.String,
  nextUnit: Schema.String,
});
const planPath = process.argv[2];
if (!planPath) throw new Error("A Cox update plan path is required.");
const plan = Schema.decodeSync(Schema.fromJsonString(Plan))(
  await readFile(planPath, "utf8"),
) satisfies LocalServiceUpdatePlan;
if (
  !stableVersion(plan.fromVersion) ||
  !stableVersion(plan.targetVersion) ||
  !isLocalServiceUpdateUnit(plan.serviceUnit) ||
  plan.operation !==
    `${plan.baseDir}/local-service-update/operations/${plan.operation.split("/").at(-1)}`
)
  throw new Error("Invalid Cox update plan.");
await activateLocalServiceUpdate(plan);
