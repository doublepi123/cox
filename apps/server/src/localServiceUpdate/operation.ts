// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
import { runLocalServiceCommand } from "./process.ts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import { backup, DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { LocalServiceUpdateState } from "@t3tools/contracts";
import { LOCAL_SERVICE_UPDATE_HELPER } from "./ownership.ts";

export interface LocalServiceUpdatePlan {
  readonly schema: 1;
  readonly fromVersion: string;
  readonly targetVersion: string;
  readonly pid: number;
  readonly serviceUnit: string;
  readonly node: string;
  readonly entry: string;
  readonly packageRoot: string;
  readonly baseDir: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly runtimeStatePath: string;
  readonly environmentId: string;
  readonly operation: string;
  readonly nextUnit: string;
}

export interface LocalServiceUpdateReceipt {
  readonly schema: 1;
  readonly targetVersion: string;
  readonly status: "activating" | "healthy" | "rolled-back" | "recovery-failed";
  readonly message: string | null;
  readonly backupDirectory: string;
  readonly databaseBackup: string;
}

export function localServiceReceiptState(
  currentVersion: string,
  receipt: LocalServiceUpdateReceipt | null,
): LocalServiceUpdateState {
  if (!receipt)
    return {
      supported: true,
      currentVersion,
      latestVersion: null,
      status: "idle",
      message: null,
      progress: null,
      backup: null,
    };
  return {
    supported: true,
    currentVersion,
    latestVersion: receipt.targetVersion,
    status:
      receipt.status === "healthy" ? "idle" : receipt.status === "activating" ? "ready" : "error",
    message:
      receipt.status === "healthy"
        ? null
        : receipt.status === "rolled-back"
          ? `The update did not become healthy. Cox ${currentVersion} was restored. ${receipt.message ?? ""}`
          : receipt.status === "recovery-failed"
            ? `The update failed and the previous version could not be restored. ${receipt.message ?? ""}`
            : "The previous update did not finish. Check the service before trying again.",
    progress: null,
    backup: {
      directory: receipt.backupDirectory,
      database: receipt.databaseBackup,
    },
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

export async function readLocalServiceReceipt(
  path: string,
): Promise<LocalServiceUpdateReceipt | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("schema" in value) ||
      value.schema !== 1 ||
      !("targetVersion" in value) ||
      typeof value.targetVersion !== "string" ||
      !("status" in value) ||
      !["activating", "healthy", "rolled-back", "recovery-failed"].includes(String(value.status)) ||
      !("backupDirectory" in value) ||
      typeof value.backupDirectory !== "string" ||
      !("databaseBackup" in value) ||
      typeof value.databaseBackup !== "string"
    )
      throw new Error("Invalid Cox update receipt.");
    return value as LocalServiceUpdateReceipt;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

export async function prepareLocalServiceUpdate(plan: LocalServiceUpdatePlan): Promise<void> {
  await mkdir(plan.operation, { recursive: true, mode: 0o700 });
  await mkdir(join(plan.baseDir, "local-service-update"), { recursive: true, mode: 0o700 });
  const backupDirectory = join(plan.operation, "backup");
  await mkdir(backupDirectory, { mode: 0o700 });
  const database = new DatabaseSync(plan.databasePath, { readOnly: true });
  try {
    await backup(database, join(backupDirectory, "statev2.sqlite"));
  } finally {
    database.close();
  }
  for (const name of ["settings.json", "client-settings.json", "keybindings.json"]) {
    try {
      const info = await lstat(join(plan.stateDir, name));
      if (!info.isFile() || info.isSymbolicLink())
        throw new Error("Settings must be regular files.");
      await cp(join(plan.stateDir, name), join(backupDirectory, name), { force: false });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        continue;
      throw error;
    }
  }
  const unitPath = join(plan.baseDir, "local-service-update", "unit");
  const previousUnit = join(plan.operation, "previous-unit");
  await writeFile(previousUnit, await readFile(unitPath, "utf8"), { mode: 0o600, flag: "wx" });
  await writeJson(join(plan.operation, "plan.json"), plan);
}

function run(command: string, args: readonly string[], timeout = 30_000): Promise<string> {
  return runLocalServiceCommand(command, args, {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    timeout,
  });
}

async function waitForVersion(plan: LocalServiceUpdatePlan, version: string): Promise<void> {
  const deadline = await Effect.runPromise(
    Effect.map(Clock.currentTimeMillis, (now) => now + 120_000),
  );
  while ((await Effect.runPromise(Clock.currentTimeMillis)) < deadline) {
    try {
      const runtime = JSON.parse(await readFile(plan.runtimeStatePath, "utf8")) as {
        pid?: number;
        origin?: string;
      };
      if (runtime.pid !== plan.pid && typeof runtime.origin === "string") {
        const origin = new URL(runtime.origin);
        if (origin.protocol !== "http:")
          throw new Error("The update health check requires the service's HTTP origin.");
        const response = await globalThis.fetch(new URL("/.well-known/t3/environment", origin), {
          signal: AbortSignal.timeout(3_000),
        });
        if (response.ok) {
          const descriptor = (await response.json()) as {
            serverVersion?: string;
            environmentId?: string;
          };
          if (
            descriptor.serverVersion === version &&
            descriptor.environmentId === plan.environmentId
          )
            return;
        }
      }
    } catch {}
    await Effect.runPromise(Effect.sleep("500 millis"));
  }
  throw new Error(`Cox ${version} did not become healthy after restart.`);
}

async function replaceUnit(plan: LocalServiceUpdatePlan, contents: string): Promise<void> {
  const temporary = join(plan.operation, "unit.next");
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, join(plan.baseDir, "local-service-update", "unit"));
  await run("systemctl", ["--user", "daemon-reload"]);
  await run("systemctl", ["--user", "restart", plan.serviceUnit], 150_000);
}

export async function activateLocalServiceUpdate(plan: LocalServiceUpdatePlan): Promise<void> {
  const receiptPath = join(plan.operation, "receipt.json");
  const backupDirectory = join(plan.operation, "backup");
  const receipt = (
    status: LocalServiceUpdateReceipt["status"],
    message: string | null,
  ): LocalServiceUpdateReceipt => ({
    schema: 1,
    targetVersion: plan.targetVersion,
    status,
    message,
    backupDirectory,
    databaseBackup: join(backupDirectory, "statev2.sqlite"),
  });
  await writeJson(receiptPath, receipt("activating", null));
  await writeJson(
    join(plan.baseDir, "local-service-update", "receipt.json"),
    receipt("activating", null),
  );
  await Effect.runPromise(Effect.sleep("1 second"));
  if (!(await lstat(plan.entry)).isFile()) throw new Error("The staged Cox entrypoint is missing.");
  if (
    await readFile(plan.entry, "utf8").then((contents) => !contents.includes("#!/usr/bin/env node"))
  )
    throw new Error("The staged Cox entrypoint is invalid.");
  if (!(await lstat(join(plan.operation, "backup", "statev2.sqlite"))).isFile())
    throw new Error("The Cox database backup is missing.");
  try {
    if (!plan.nextUnit.includes("__COX_ENTRY__"))
      throw new Error("The Cox update unit template is missing its entry placeholder.");
    await replaceUnit(plan, plan.nextUnit.replaceAll("__COX_ENTRY__", plan.entry));
    await waitForVersion(plan, plan.targetVersion);
    await writeJson(receiptPath, receipt("healthy", null));
    await writeJson(
      join(plan.baseDir, "local-service-update", "receipt.json"),
      receipt("healthy", null),
    );
  } catch (error) {
    try {
      await replaceUnit(plan, await readFile(join(plan.operation, "previous-unit"), "utf8"));
      await run("systemctl", ["--user", "reset-failed", plan.serviceUnit]);
      await waitForVersion(plan, plan.fromVersion);
      await writeJson(receiptPath, receipt("rolled-back", String(error)));
      await writeJson(
        join(plan.baseDir, "local-service-update", "receipt.json"),
        receipt("rolled-back", String(error)),
      );
    } catch (recoveryError) {
      await writeJson(receiptPath, receipt("recovery-failed", String(recoveryError)));
      await writeJson(
        join(plan.baseDir, "local-service-update", "receipt.json"),
        receipt("recovery-failed", String(recoveryError)),
      );
      throw recoveryError;
    }
  }
}

export async function launchLocalServiceUpdate(plan: LocalServiceUpdatePlan): Promise<void> {
  const helper = fileURLToPath(new URL("localServiceUpdate/activation.mjs", import.meta.url));
  await run("systemd-run", [
    "--user",
    "--unit=" + LOCAL_SERVICE_UPDATE_HELPER,
    "--collect",
    "--property=Type=exec",
    "--property=TimeoutStartSec=300",
    "--property=Environment=PATH=" + (process.env.PATH ?? "/usr/bin:/bin"),
    plan.node,
    helper,
    join(plan.operation, "plan.json"),
  ]);
}
