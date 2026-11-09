// @effect-diagnostics nodeBuiltinImport:off
import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";
import { activateLocalServiceUpdate, type LocalServiceUpdatePlan } from "./operation.ts";
import { stableVersion } from "./ownership.ts";

const Plan = Schema.Struct({
  schema: Schema.Literal(1),
  fromVersion: Schema.String,
  targetVersion: Schema.String,
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  serviceUnit: Schema.String,
  node: Schema.String,
  entry: Schema.String,
  packageRoot: Schema.String,
  baseDir: Schema.String,
  stateDir: Schema.String,
  databasePath: Schema.String,
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
  plan.serviceUnit !== "cox.service" ||
  plan.operation !==
    `${plan.baseDir}/local-service-update/operations/${plan.operation.split("/").at(-1)}`
)
  throw new Error("Invalid Cox update plan.");
await activateLocalServiceUpdate(plan);
