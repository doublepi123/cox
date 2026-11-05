import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const output = join(root, "release", "desktop");
const executable =
  process.platform === "darwin"
    ? join(
        output,
        process.arch === "arm64" ? "mac-arm64" : "mac",
        "Cox.app",
        "Contents",
        "MacOS",
        "Cox",
      )
    : join(
        output,
        `${process.platform === "win32" ? "win" : "linux"}${process.arch === "arm64" ? "-arm64" : ""}-unpacked`,
        process.platform === "win32" ? "Cox.exe" : "cox-desktop",
      );
assert.ok(existsSync(executable), "Build the desktop package before testing its window.");
const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-app-"));
const environment: Record<string, string> = Object.fromEntries(
  Object.entries({
    ...process.env,
    HOME: temporary,
    USERPROFILE: temporary,
    XDG_CONFIG_HOME: join(temporary, "config"),
    XDG_CACHE_HOME: join(temporary, "cache"),
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
);
const application = await _electron.launch({
  executablePath: executable,
  env: environment,
  timeout: 30_000,
  args: process.platform === "linux" ? ["--no-sandbox"] : [],
});
const applicationProcess = application.process();
try {
  const page = await application.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 90_000 });
  await page.waitForFunction(
    async () => {
      const response = await fetch("/api/auth/session");
      const session = (await response.json()) as { authenticated?: boolean };
      return session.authenticated === true;
    },
    undefined,
    { timeout: 30_000 },
  );
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  assert.deepEqual(
    await page.evaluate(() => ({
      require: typeof Reflect.get(window, "require"),
      process: typeof Reflect.get(window, "process"),
    })),
    { require: "undefined", process: "undefined" },
  );
  await page.evaluate(() => navigator.clipboard.writeText("Cox desktop smoke test"));
  const runtimePath = join(temporary, ".cox", "desktop", "userdata", "server-runtime.json");
  const before = await readFile(runtimePath, "utf8");
  const second = spawn(executable, process.platform === "linux" ? ["--no-sandbox"] : [], {
    env: environment,
    stdio: "ignore",
  });
  const [code] = await once(second, "exit", { signal: AbortSignal.timeout(15_000) });
  assert.equal(code, 0);
  assert.equal(await readFile(runtimePath, "utf8"), before);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  await application.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  await application.close();
  assert.equal(existsSync(runtimePath), false);
  console.log(
    "PASS: packaged app window, embedded backend, automatic local sign-in, renderer isolation, clipboard write, single-instance activation and graceful quit.",
  );
} finally {
  if (applicationProcess.exitCode === null && applicationProcess.signalCode === null) {
    applicationProcess.kill("SIGKILL");
  }
  await rm(temporary, { recursive: true, force: true });
}
