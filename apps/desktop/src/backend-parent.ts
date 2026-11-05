import { spawnSync } from "node:child_process";
import { join } from "node:path";

if (process.send) {
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
}
