import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

if (process.argv[2] === "--cox-monitor-backend" && process.send) {
  const backendPid = Number(process.argv[3]);
  if (process.platform === "win32" || backendPid <= 1 || backendPid !== process.ppid)
    process.exit(0);
  process.once("disconnect", () => process.exit(0));
  process.stdin.once("end", () => {
    process.kill(-backendPid, "SIGCONT");
    setTimeout(() => process.kill(-backendPid, "SIGKILL"), 5_000);
  });
  process.stdin.resume();
}

const desktopParent = process.env.COX_DESKTOP_PARENT_PID;
if (desktopParent !== undefined) {
  delete process.env.COX_DESKTOP_PARENT_PID;
  if (!process.send || desktopParent !== String(process.ppid) || !process.connected)
    process.exit(0);
  const homeFlag = process.argv.indexOf("--home-dir");
  const home = homeFlag >= 0 ? process.argv[homeFlag + 1] : process.env.COX_HOME;
  if (home) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const owner = join(home, "backend-owner.json");
    const temporary = join(home, "backend-owner-" + randomUUID() + ".json");
    writeFileSync(temporary, JSON.stringify({ pid: process.pid, parentPid: process.ppid }), {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, owner);
    process.once("exit", () => {
      try {
        const state: unknown = JSON.parse(readFileSync(owner, "utf8"));
        if (
          typeof state === "object" &&
          state !== null &&
          "pid" in state &&
          state.pid === process.pid
        )
          unlinkSync(owner);
      } catch {}
    });
  }
  if (process.platform !== "win32" && process.env.COX_DESKTOP_RECOVERY_PIPE === "1") {
    delete process.env.COX_DESKTOP_RECOVERY_PIPE;
    const monitor = spawn(
      process.execPath,
      [fileURLToPath(import.meta.url), "--cox-monitor-backend", String(process.pid)],
      { stdio: [4, "ignore", "ignore", "ipc"] },
    );
    await new Promise<void>((resolve, reject) => {
      monitor.once("error", reject);
      monitor.once("spawn", resolve);
    });
    monitor.channel?.unref();
    monitor.unref();
  }
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    setTimeout(() => {
      if (process.platform === "win32") {
        spawnSync(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(process.pid), "/T", "/F"],
          { windowsHide: true },
        );
      } else {
        process.kill(-process.pid, "SIGKILL");
      }
      process.exit(1);
    }, 10_000).unref();
    if (process.listenerCount("SIGINT") > 0) process.emit("SIGINT");
    else process.exit(0);
  };
  process.on("message", (message: unknown) => {
    if (message === "shutdown") shutdown();
  });
  process.once("disconnect", shutdown);
  if (!process.connected) shutdown();
  const send = process.send.bind(process);
  await new Promise<void>((resolve) => {
    const start = (message: unknown) => {
      if (message !== "cox:backend-start") return;
      process.off("message", start);
      resolve();
    };
    process.on("message", start);
    send("cox:backend-ready-to-start", (error) => {
      if (error) process.exit(0);
    });
  });
  if (shuttingDown || !process.connected) process.exit(0);
}
