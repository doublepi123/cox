import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
    writeFileSync(temporary, JSON.stringify({ pid: process.pid }), { mode: 0o600, flag: "wx" });
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
