import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron, type ElectronApplication } from "playwright-core";
import { MacAppUpdate } from "../src/mac-update.ts";
import { macCommand } from "../src/mac-update-platform.ts";
import {
  macUpdatePaths,
  processIsAlive,
  type MacUpdateTransaction,
} from "../src/mac-update-transaction.ts";

assert.equal(process.platform, "darwin", "The macOS update smoke requires macOS.");
const root = resolve(import.meta.dirname, "../../..");
const flavor = process.env.COX_DESKTOP_CLIENT_ONLY === "true" ? "client-only" : "bundled";
const output = join(root, "release/desktop", flavor);
const build = JSON.parse(
  await readFile(join(output, `BUILD-${flavor}-darwin-${process.arch}.json`), "utf8"),
) as { version: string; coxVersion: string | null; artifactBaseName: string };
const temporary = await realpath(await mkdtemp(join(tmpdir(), "cox-mac-update-smoke-")));
const userHome = join(temporary, "用户 home");
const home = join(userHome, ".cox/desktop");
const application = join(userHome, "Applications/Cox.app");
const source = join(output, process.arch === "arm64" ? "mac-arm64" : "mac", "Cox.app");
await mkdir(join(userHome, "Applications"), { recursive: true });
await macCommand("ditto", [source, application]);
const environment = {
  ...process.env,
  HOME: userHome,
  USERPROFILE: userHome,
  XDG_CONFIG_HOME: join(userHome, "config"),
  XDG_CACHE_HOME: join(userHome, "cache"),
};
let previous: ElectronApplication | undefined;
let previousProcess: ReturnType<ElectronApplication["process"]> | undefined;
let restartedPid: number | undefined;
const updater = new MacAppUpdate({
  home,
  application,
  node: join(application, "Contents/Resources/runtime/bin/node"),
  helperDirectory: join(root, "apps/desktop/dist"),
  currentVersion: build.version,
  offline: true,
});
async function stopOwnedProcess(pid: number) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !processIsAlive(pid)) return;
  process.kill(pid, "SIGTERM");
  const deadline = performance.now() + 20_000;
  while (processIsAlive(pid) && performance.now() < deadline) await delay(100);
  if (processIsAlive(pid)) {
    process.kill(pid, "SIGKILL");
    while (processIsAlive(pid) && performance.now() < deadline + 5_000) await delay(100);
  }
  assert.equal(
    processIsAlive(pid),
    false,
    "Test-owned process must stop before deleting its data.",
  );
}
try {
  previous = await _electron.launch({
    executablePath: join(application, "Contents/MacOS/Cox"),
    env: environment,
    args: flavor === "client-only" ? [] : ["--offline"],
    timeout: 30_000,
  });
  previousProcess = previous.process();
  const page = await previous.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 600_000 });
  await page.waitForFunction(
    () => Boolean(document.querySelector('[data-slot="sidebar-wrapper"]')),
    undefined,
    { timeout: 60_000 },
  );
  await writeFile(join(home, "userdata", "update-smoke.txt"), "preserved");
  await updater.prepare(join(output, `${build.artifactBaseName}-mac-${process.arch}.dmg`), {
    version: build.version,
    architecture: process.arch === "arm64" ? "arm64" : "x64",
    flavor,
    backendVersion: build.coxVersion,
  });
  const id = (await readdir(join(home, "client-updates/mac-updates")))[0]!;
  const paths = macUpdatePaths(home, id, application);
  const transaction = JSON.parse(
    await readFile(join(paths.directory, "transaction.json"), "utf8"),
  ) as MacUpdateTransaction;
  await writeFile(
    join(paths.directory, "transaction.json"),
    JSON.stringify({ ...transaction, oldPid: previousProcess.pid }),
  );
  const exited = once(previousProcess, "exit", { signal: AbortSignal.timeout(30_000) });
  await previous.evaluate(({ app }) => app.quit());
  await page.getByRole("button", { name: /^(Quit Cox|退出 Cox)$/ }).click();
  assert.equal((await exited)[0], 0);
  await updater.apply();
  const deadline = performance.now() + 180_000;
  while (true) {
    const status = JSON.parse(await readFile(join(paths.directory, "status.json"), "utf8")) as {
      phase: string;
      message?: string;
    };
    if (status.phase === "committed") break;
    assert.ok(!["error", "rolled-back"].includes(status.phase), status.message ?? status.phase);
    assert.ok(
      performance.now() < deadline,
      "The replacement must acknowledge a healthy backend and browser UI.",
    );
    await delay(100);
  }
  const healthy = JSON.parse(await readFile(join(paths.directory, "healthy.json"), "utf8")) as {
    pid: number;
    version: string;
  };
  restartedPid = healthy.pid;
  assert.equal(healthy.version, build.version);
  assert.ok(processIsAlive(restartedPid));
  assert.equal(await readFile(join(home, "userdata/update-smoke.txt"), "utf8"), "preserved");
  console.log(
    "PASS: DMG verification, automatic application replacement, detached helper, relaunch, backend/UI health acknowledgment and preserved desktop data.",
  );
} finally {
  if (previousProcess && previousProcess.exitCode === null && previousProcess.signalCode === null)
    await stopOwnedProcess(previousProcess.pid!);
  if (restartedPid) await stopOwnedProcess(restartedPid);
  let owner: { pid?: number; parentPid?: number } = {};
  try {
    owner = JSON.parse(await readFile(join(home, "backend-owner.json"), "utf8"));
  } catch {}
  if (owner.parentPid && owner.parentPid !== previousProcess?.pid)
    await stopOwnedProcess(owner.parentPid);
  if (owner.pid) await stopOwnedProcess(owner.pid);
  await updater.close();
  await rm(temporary, { recursive: true, force: true });
}
