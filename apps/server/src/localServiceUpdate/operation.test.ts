// @effect-diagnostics nodeBuiltinImport:off
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vite-plus/test";
import {
  activateLocalServiceUpdate,
  prepareLocalServiceUpdate,
  readLocalServiceReceipt,
} from "./operation.ts";
import { runLocalServiceCommand } from "./process.ts";

vi.mock("./process.ts", () => ({ runLocalServiceCommand: vi.fn() }));

it.each([true, false])(
  "migrates the database from a stopped-service snapshot (new version healthy: %s)",
  async (healthy) => {
    const directory = await mkdtemp(join(tmpdir(), "cox-update-migration-"));
    const operation = join(directory, "local-service-update", "operations", "update");
    const databasePath = join(directory, "statev2.sqlite");
    const runtimeStatePath = join(directory, "runtime.json");
    const entry = join(directory, "candidate.mjs");
    const node = process.execPath;
    const nextUnit = `[Service]\nExecStart=\nExecStart="${node}" "${entry}"\n`;
    const rows = (path: string) => {
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        return {
          values: database.prepare("SELECT value FROM example ORDER BY value").all(),
          migrated: database.prepare("SELECT name FROM sqlite_master WHERE name = 'migrated'").all()
            .length,
        };
      } finally {
        database.close();
      }
    };
    try {
      const live = new DatabaseSync(databasePath);
      live.exec(
        "PRAGMA journal_mode = WAL; CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('prepared')",
      );
      live.close();
      await writeFile(entry, "#!/usr/bin/env node\n");
      const plan = {
        schema: 1 as const,
        fromVersion: "0.2.30",
        targetVersion: "0.2.31",
        pid: 123,
        serviceUnit: "cox.service",
        node,
        entry,
        dropIn: join(directory, "90-cox-update.conf"),
        baseDir: directory,
        stateDir: directory,
        databasePath,
        backupDatabase: true,
        migrateDatabase: true,
        runtimeStatePath,
        environmentId: "test",
        operation,
        nextUnit,
      };
      await prepareLocalServiceUpdate(plan);
      const later = new DatabaseSync(databasePath);
      later.exec("INSERT INTO example VALUES ('written after prepare')");
      later.close();

      let pid = 123;
      let running = true;
      const commands: string[] = [];
      const start = async () => {
        running = true;
        pid++;
        await writeFile(runtimeStatePath, JSON.stringify({ pid, origin: "http://localhost" }));
      };
      vi.mocked(runLocalServiceCommand).mockImplementation(async (command, args) => {
        if (command === "systemctl") {
          if (args.includes("--property=MainPID")) return running ? String(pid) : "0";
          const action = args[1] ?? "";
          commands.push(action);
          if (action === "stop") running = false;
          if (action === "restart") await start();
          if (action === "start") {
            const migrating = new DatabaseSync(databasePath);
            migrating.exec("CREATE TABLE migrated (id INTEGER)");
            migrating.close();
            if (!healthy) throw new Error("The new Cox service failed to start.");
            await start();
          }
          return "";
        }
        if (args.includes("GetUnit"))
          return JSON.stringify({
            type: "o",
            data: ["/org/freedesktop/systemd1/unit/cox_2eservice"],
          });
        if (args.includes("DropInPaths"))
          return JSON.stringify({ type: "as", data: [plan.dropIn] });
        if (args.includes("ExecStart"))
          return JSON.stringify({
            type: "a(sasbttttuii)",
            data: [[node, [node, entry], false, 0, 0, 0, 0, 0, 0, 0]],
          });
        throw new Error("Unexpected systemd command");
      });
      vi.stubGlobal("fetch", async () =>
        Response.json({
          serverVersion: healthy ? plan.targetVersion : plan.fromVersion,
          environmentId: "test",
        }),
      );

      await activateLocalServiceUpdate(plan);

      const receipt = await readLocalServiceReceipt(join(operation, "receipt.json"));
      const backup = join(operation, "backup", "statev2.sqlite");
      expect(rows(backup)).toEqual({
        values: [{ value: "prepared" }, { value: "written after prepare" }],
        migrated: 0,
      });
      if (healthy) {
        expect(receipt).toMatchObject({ status: "healthy", databaseBackup: backup });
        expect(commands).toEqual(["daemon-reload", "stop", "start"]);
        expect(rows(databasePath).migrated).toBe(1);
      } else {
        expect(receipt).toMatchObject({
          status: "rolled-back",
          message: expect.stringContaining("failed to start"),
        });
        expect(commands).toEqual([
          "daemon-reload",
          "stop",
          "start",
          "daemon-reload",
          "stop",
          "reset-failed",
          "restart",
        ]);
        expect(rows(databasePath)).toEqual(rows(backup));
      }
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([false, true])(
  "verifies the systemd update before restart (ExecStart conflict: %s)",
  async (conflict) => {
    const root = await mkdtemp(join(tmpdir(), "cox-update-systemd-"));
    const directory = join(root, conflict ? "home" : "resolved home");
    const home = join(root, "home");
    const operation = join(directory, "operations", "update");
    const entry = join(directory, "candidate $one % two.mjs");
    const node = process.execPath;
    const dropIn = join(home, "90-cox-update.conf");
    const resolvedDropIn = join(directory, "90-cox-update.conf");
    const override = join(directory, "zz-npm-runtime.conf");
    const runtimeStatePath = join(directory, "runtime.json");
    const files = conflict ? [resolvedDropIn, override] : [resolvedDropIn];
    try {
      await mkdir(join(operation, "backup"), { recursive: true });
      await mkdir(join(directory, "local-service-update"));
      if (!conflict) await symlink(directory, home);
      await writeFile(entry, "#!/usr/bin/env node\n");
      await writeFile(join(operation, "backup", "statev2.sqlite"), "preserved");
      if (conflict) {
        await writeFile(dropIn, "[Service]\nExecStart=/usr/bin/false\n");
        await writeFile(override, "[Service]\nExecStart=\nExecStart=/usr/bin/true\n");
      }
      let pid = 123;
      const systemd = vi.mocked(runLocalServiceCommand);
      systemd.mockImplementation(async (command, args) => {
        if (command === "systemctl") {
          if (args.includes("--property=MainPID")) return String(pid);
          if (args.includes("--property=DropInPaths")) return files.join(" ");
          if (args.includes("restart")) {
            pid++;
            await writeFile(runtimeStatePath, JSON.stringify({ pid, origin: "http://localhost" }));
          }
          return "";
        }
        if (args.includes("GetUnit")) {
          return JSON.stringify({
            type: "o",
            data: ["/org/freedesktop/systemd1/unit/cox_2eservice"],
          });
        }
        if (args.includes("DropInPaths")) return JSON.stringify({ type: "as", data: files });
        if (args.includes("ExecStart")) {
          const executable = conflict ? "/usr/bin/true" : node;
          const argv = conflict
            ? [executable]
            : [node, entry.replace("$", () => "$$"), "--no-browser"];
          return JSON.stringify({
            type: "a(sasbttttuii)",
            data: [[executable, argv, false, 0, 0, 0, 0, 0, 0, 0]],
          });
        }
        throw new Error("Unexpected systemd command");
      });
      vi.stubGlobal("fetch", async () =>
        Response.json({ serverVersion: "0.2.17", environmentId: "test" }),
      );

      await activateLocalServiceUpdate({
        schema: 1,
        fromVersion: "0.2.16",
        targetVersion: "0.2.17",
        pid: 123,
        serviceUnit: "cox.service",
        node,
        entry,
        dropIn,
        baseDir: directory,
        stateDir: directory,
        databasePath: join(directory, "statev2.sqlite"),
        runtimeStatePath,
        environmentId: "test",
        operation,
        nextUnit:
          '[Service]\nExecStart=\nExecStart="' +
          node +
          '" "' +
          entry.replace("$", () => "$$").replace("%", "%%") +
          '" "--no-browser"\n',
      });

      const receipt = await readLocalServiceReceipt(join(operation, "receipt.json"));
      if (conflict) {
        expect(receipt?.status).toBe("rolled-back");
        expect(receipt?.message).toContain(override);
        expect(pid).toBe(123);
        expect(await readFile(dropIn, "utf8")).toBe("[Service]\nExecStart=/usr/bin/false\n");
      } else {
        expect(receipt?.status).toBe("healthy");
        expect(pid).toBe(124);
      }
    } finally {
      vi.unstubAllGlobals();
      vi.resetAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  },
);
