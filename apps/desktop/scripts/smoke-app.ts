import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { _electron } from "playwright-core";

const root = resolve(import.meta.dirname, "../../..");
const clientOnly = process.env.COX_DESKTOP_CLIENT_ONLY === "true";
const output = join(root, "release", "desktop", clientOnly ? "client-only" : "bundled");
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
  args: [
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...(clientOnly ? [] : ["--offline"]),
  ],
});
const applicationProcess = application.process();
try {
  const page = await application.firstWindow();
  page.on("pageerror", (error) => console.error("Renderer error:", error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Renderer console:", message.text());
  });
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: clientOnly ? 600_000 : 90_000 });
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
    await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((candidate) => candidate.isVisible()).length,
    ),
    1,
  );
  await page.waitForFunction(() =>
    Boolean(document.querySelector('[data-slot="sidebar-wrapper"]')),
  );
  if (process.platform === "linux")
    await page.evaluate(() => {
      const bridge = Reflect.get(window, "coxDesktop");
      bridge.onQuitRequested(() => bridge.answerQuit(true));
      bridge.ready({ settingsWindow: true });
    });
  const mainUrl = page.url();
  let settings = application
    .windows()
    .find((candidate) => candidate.url().includes("/settings/general"));
  for (let attempt = 0; !settings && attempt < 600; attempt++) {
    await delay(50);
    settings = application
      .windows()
      .find((candidate) => candidate.url().includes("/settings/general"));
  }
  assert.ok(settings, "The main window should prewarm a hidden settings window.");
  await settings.waitForFunction(() =>
    Boolean(document.querySelector('[data-slot="sidebar-wrapper"]')),
  );
  assert.equal(
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((candidate) => candidate.webContents.getURL().includes("/settings/general"))
        ?.isVisible(),
    ),
    false,
  );
  await page.evaluate(async () => {
    const bridge = Reflect.get(window, "coxDesktop") as {
      openSettings(path: string): Promise<void>;
    };
    await bridge.openSettings("/settings/about");
  });
  settings.on("pageerror", (error) => console.error("Settings renderer error:", error));
  await settings.waitForURL(/\/settings\/about$/, { timeout: 30_000 });
  await settings.getByRole("heading", { name: /^(Desktop client|桌面客户端)$/ }).waitFor();
  assert.equal(await settings.getByRole("button", { name: /^(Close|关闭)$/ }).count(), 0);
  assert.equal(
    await settings.evaluate(() => Reflect.get(window, "coxDesktop").windowKind),
    "settings",
  );
  assert.equal(page.url(), mainUrl);
  assert.equal(await settings.locator("[data-app-modal]").count(), 0);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    2,
  );
  await page.evaluate(async () => Reflect.get(window, "coxDesktop").openSettings("/settings"));
  assert.equal(settings.url().endsWith("/settings/about"), true);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    2,
  );
  await settings.evaluate(() => {
    const key = "cox:client-settings:v1";
    const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
    localStorage.setItem(key, JSON.stringify({ ...stored, glassOpacity: 85 }));
  });
  await page.waitForFunction(
    () => document.documentElement.style.getPropertyValue("--glass-opacity") === "85%",
  );
  await settings.evaluate(() => Reflect.set(window, "__coxSettingsSmokeMarker", "retained"));
  await application.evaluate(({ BrowserWindow }) => {
    const target = BrowserWindow.getAllWindows().find((candidate) =>
      candidate.webContents.getURL().includes("/settings/about"),
    );
    target?.close();
  });
  await settings.waitForFunction(() => document.visibilityState === "hidden");
  assert.equal(
    await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((candidate) => candidate.isVisible()).length,
    ),
    1,
  );
  assert.equal(await readFile(runtimePath, "utf8"), before);
  assert.equal(page.url(), mainUrl);
  await page.evaluate(() => Reflect.get(window, "coxDesktop").openSettings("/settings/general"));
  await settings.waitForURL(/\/settings\/general$/, { timeout: 30_000 });
  await settings.waitForFunction(() => document.visibilityState === "visible");
  assert.equal(
    await settings.evaluate(() => Reflect.get(window, "__coxSettingsSmokeMarker")),
    "retained",
  );
  if (process.platform === "win32" || process.platform === "darwin") {
    if (process.platform === "win32") {
      assert.equal(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isMenuBarVisible(),
        ),
        false,
      );
    }
    await page.waitForFunction(() => document.documentElement.classList.contains("wco"));
    assert.equal(
      await page.evaluate(() => document.documentElement.dataset.coxDesktop),
      process.platform === "darwin" ? "macos" : "windows",
    );
    if (process.platform === "darwin") {
      assert.deepEqual(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
        ),
        { x: 16, y: 19 },
      );
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      assert.equal(
        await application.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]?.isVisible(),
        ),
        false,
      );
      assert.equal(existsSync(runtimePath), true);
      await application.evaluate(({ app }) => app.emit("activate"));
    }
    const exit = once(applicationProcess, "exit", { signal: AbortSignal.timeout(20_000) });
    await application.evaluate(({ app }) => app.quit());
    const [exitCode] = await exit;
    assert.equal(exitCode, 0);
  } else {
    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await application.close();
  }
  assert.equal(existsSync(runtimePath), false);
  if (clientOnly) {
    const statePath = join(temporary, ".cox", "desktop", "backend-updates", "state.json");
    const installed = JSON.parse(await readFile(statePath, "utf8")) as {
      active: { version: string };
    };
    assert.ok(installed.active.version);
    const offline = await _electron.launch({
      executablePath: executable,
      env: environment,
      timeout: 30_000,
      args: ["--offline", ...(process.platform === "linux" ? ["--no-sandbox"] : [])],
    });
    const offlineProcess = offline.process();
    try {
      const offlinePage = await offline.firstWindow();
      await offlinePage.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 90_000 });
      await offlinePage.waitForFunction(
        async () => {
          const response = await fetch("/api/auth/session");
          const session = (await response.json()) as { authenticated?: boolean };
          return session.authenticated === true;
        },
        undefined,
        { timeout: 30_000 },
      );
      if (process.platform === "darwin" || process.platform === "win32")
        await offlinePage.waitForFunction(() => document.documentElement.classList.contains("wco"));
      const version = await offlinePage.evaluate(async () => {
        const bridge = Reflect.get(window, "coxDesktop") as {
          getBackendUpdate(): Promise<{ currentVersion: string }>;
        };
        return (await bridge.getBackendUpdate()).currentVersion;
      });
      assert.equal(version, installed.active.version);
      const exited = once(offlineProcess, "exit", { signal: AbortSignal.timeout(30_000) });
      await offline.evaluate(({ app }) => app.quit());
      assert.equal((await exited)[0], 0);
      console.log("PASS: client-only first installation and cached offline second launch.");
    } finally {
      if (offlineProcess.exitCode === null && offlineProcess.signalCode === null) {
        const exited = once(offlineProcess, "exit");
        offlineProcess.kill("SIGKILL");
        await exited;
      }
    }
  }
  console.log(
    "PASS: packaged app window, embedded backend, automatic local sign-in, renderer isolation, clipboard write, single-instance activation, independent settings window reuse, shared preferences and graceful quit.",
  );
} catch (error) {
  console.error("Packaged window smoke failed:", error);
  console.error(
    "Electron output:",
    applicationProcess.stdout?.read(),
    applicationProcess.stderr?.read(),
  );
  for (const page of application.windows()) {
    console.error(
      "Renderer state:",
      await page
        .evaluate(() => ({
          url: location.href,
          bridge: typeof Reflect.get(window, "coxDesktop"),
          desktop: document.documentElement.dataset.coxDesktop,
          classes: document.documentElement.className,
          text: document.body.innerText.slice(0, 2000),
        }))
        .catch(String),
    );
  }
  throw error;
} finally {
  if (applicationProcess.exitCode === null && applicationProcess.signalCode === null) {
    const exited = once(applicationProcess, "exit", { signal: AbortSignal.timeout(15_000) });
    applicationProcess.kill("SIGKILL");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(
    (error: unknown) => {
      console.error("Could not clean smoke directory:", temporary, error);
    },
  );
}
