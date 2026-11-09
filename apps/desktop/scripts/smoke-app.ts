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
async function waitForSettingsVisibility(visible: boolean) {
  for (let attempt = 0; attempt < 600; attempt++) {
    const current = await application.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((candidate) => candidate.webContents.getURL().includes("/settings/"))
          ?.isVisible() ?? false,
    );
    if (current === visible) return;
    await delay(50);
  }
  throw new Error(`Settings window did not become ${visible ? "visible" : "hidden"}.`);
}
try {
  const page = await application.firstWindow();
  page.on("pageerror", (error) => console.error("Renderer error:", error));
  page.on("console", (message) => {
    if (message.type() === "error") console.error("Renderer console:", message.text());
  });
  if (clientOnly) {
    await page
      .getByRole("button", { name: /^(Use local mode|使用本地模式)$/ })
      .waitFor({ timeout: 90_000 });
    assert.equal(
      existsSync(join(temporary, ".cox", "desktop", "backend-updates", "state.json")),
      false,
    );
    await page.getByRole("button", { name: /^(Use local mode|使用本地模式)$/ }).click();
  }
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
  if (process.platform === "linux")
    await settings.evaluate(() => {
      const bridge = Reflect.get(window, "coxDesktop");
      bridge.onSettingsCloseRequested(() => bridge.closeSettings());
      bridge.ready({ settingsWindow: true });
    });
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
  await application.evaluate(({ app, Menu }) => {
    const { join } = process.getBuiltinModule("path");
    const require = process
      .getBuiltinModule("module")
      .createRequire(join(app.getAppPath(), "package.json"));
    const { BackendUpdates } =
      require("./dist/backend-updates.js") as typeof import("../src/backend-updates.ts");
    const { ClientUpdates } =
      require("./dist/client-updates.js") as typeof import("../src/client-updates.ts");
    const originalBackend = BackendUpdates.prototype.check;
    const originalClient = ClientUpdates.prototype.check;
    const state = {
      backend: 0,
      client: 0,
      restore: () => {
        BackendUpdates.prototype.check = originalBackend;
        ClientUpdates.prototype.check = originalClient;
      },
    };
    Reflect.set(globalThis, "__coxUnifiedUpdateSmoke", state);
    BackendUpdates.prototype.check = async function () {
      state.backend++;
      return this.getState();
    };
    ClientUpdates.prototype.check = async function () {
      state.client++;
      return this.getState();
    };
    const menu = Menu.getApplicationMenu();
    const check = menu?.getMenuItemById("cox-check-updates");
    if (!check || menu?.getMenuItemById("cox-client-update-install"))
      throw new Error("Expected a single check action.");
    check.click();
  });
  await settings.waitForFunction(async () => {
    const result = await Reflect.get(window, "coxDesktop").checkUpdates();
    return Boolean(result.backend && result.client);
  });
  const checked = await application.evaluate(() => {
    const state = Reflect.get(globalThis, "__coxUnifiedUpdateSmoke");
    const counts = { backend: state.backend, client: state.client };
    state.restore();
    return counts;
  });
  assert.ok(checked.backend >= 1);
  assert.equal(checked.backend, checked.client);
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
  await waitForSettingsVisibility(false);
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
  await waitForSettingsVisibility(true);
  assert.equal(
    await settings.evaluate(() => Reflect.get(window, "__coxSettingsSmokeMarker")),
    "retained",
  );
  const relaunchMarker = join(temporary, "backend-relaunch.json");
  await application.evaluate(
    ({ app, dialog }, paths) => {
      const { join } = process.getBuiltinModule("path");
      const { existsSync, writeFileSync } = process.getBuiltinModule("fs");
      const require = process
        .getBuiltinModule("module")
        .createRequire(join(app.getAppPath(), "package.json"));
      const { BackendUpdates } =
        require("./dist/backend-updates.js") as typeof import("../src/backend-updates.ts");
      const { ClientUpdates } =
        require("./dist/client-updates.js") as typeof import("../src/client-updates.ts");
      const { BackendProcess } = require("./dist/backend.js") as typeof import("../src/backend.ts");
      const state = { ready: false, response: 0, confirmations: 0, errors: 0, stopFailures: 0 };
      Reflect.set(globalThis, "__coxBackendRestartSmoke", state);
      const getState = BackendUpdates.prototype.getState;
      BackendUpdates.prototype.getState = function () {
        const current = getState.call(this);
        return state.ready ? { ...current, status: "ready", latestVersion: "99.0.0" } : current;
      };
      const getClientState = ClientUpdates.prototype.getState;
      ClientUpdates.prototype.getState = function () {
        const current = getClientState.call(this);
        return state.ready
          ? { ...current, status: "idle", latestVersion: current.currentVersion, message: null }
          : current;
      };
      const stop = BackendProcess.prototype.stop;
      BackendProcess.prototype.stop = async function () {
        if (state.stopFailures > 0) {
          state.stopFailures--;
          throw new Error("Controlled backend stop failure");
        }
        await stop.call(this);
      };
      dialog.showMessageBox = async () => {
        state.confirmations++;
        return { response: state.response, checkboxChecked: false };
      };
      dialog.showErrorBox = () => {
        state.errors++;
      };
      process.argv.push("--cox-update-transaction=completed-smoke-transaction");
      app.relaunch = (options) => {
        writeFileSync(
          paths.marker,
          JSON.stringify({
            backendStopped: !existsSync(paths.runtime),
            confirmations: state.confirmations,
            args: options?.args,
          }),
        );
      };
    },
    { runtime: runtimePath, marker: relaunchMarker },
  );
  const notReady = await page.evaluate(async () => {
    try {
      await Reflect.get(window, "coxDesktop").applyBackendUpdate();
      return "accepted";
    } catch (error) {
      return String(error);
    }
  });
  assert.match(notReady, /not ready|尚未就绪/);
  assert.equal(
    await application.evaluate(
      () => Reflect.get(globalThis, "__coxBackendRestartSmoke").confirmations,
    ),
    0,
  );
  await application.evaluate(() => {
    Reflect.get(globalThis, "__coxBackendRestartSmoke").ready = true;
  });
  await page.evaluate(() => Reflect.get(window, "coxDesktop").applyBackendUpdate());
  assert.equal(await readFile(runtimePath, "utf8"), before);
  assert.equal(existsSync(relaunchMarker), false);
  await application.evaluate(() => {
    const state = Reflect.get(globalThis, "__coxBackendRestartSmoke");
    state.response = 1;
    state.stopFailures = 1;
  });
  await page.evaluate(() => Reflect.get(window, "coxDesktop").applyBackendUpdate());
  assert.equal(
    await application.evaluate(() => Reflect.get(globalThis, "__coxBackendRestartSmoke").errors),
    1,
  );
  assert.equal(await readFile(runtimePath, "utf8"), before);
  assert.equal(existsSync(relaunchMarker), false);
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
      await application.evaluate(async ({ BrowserWindow }) => {
        const target = BrowserWindow.getAllWindows()[0];
        if (!target) return;
        const hidden = target.isVisible()
          ? new Promise<void>((resolve) => target.once("hide", resolve))
          : Promise.resolve();
        target.close();
        await hidden;
      });
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
    await page.evaluate(() => {
      void Reflect.get(window, "coxDesktop").applyBackendUpdate();
    });
    const [exitCode] = await exit;
    assert.equal(exitCode, 0);
  } else {
    const exit = once(applicationProcess, "exit", { signal: AbortSignal.timeout(20_000) });
    await page.evaluate(() => {
      void Reflect.get(window, "coxDesktop").applyBackendUpdate();
    });
    assert.equal((await exit)[0], 0);
  }
  assert.equal(existsSync(runtimePath), false);
  const relaunched = JSON.parse(await readFile(relaunchMarker, "utf8")) as {
    backendStopped: boolean;
    confirmations: number;
    args: string[];
  };
  assert.equal(relaunched.backendStopped, true);
  assert.equal(relaunched.confirmations, 3);
  assert.equal(
    relaunched.args.some((argument) => argument.startsWith("--cox-update-transaction=")),
    false,
  );
  if (!clientOnly) assert.equal(relaunched.args.includes("--offline"), true);
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
    "PASS: packaged app window, embedded backend, automatic local sign-in, renderer isolation, clipboard write, single-instance activation, independent settings window reuse, shared preferences, backend update consent, cancellation, stop failure recovery and shutdown before relaunch.",
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
