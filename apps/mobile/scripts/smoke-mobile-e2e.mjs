import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { seedThread } from "./lib/smoke-fixtures.mjs";
import { addServer, assertServerIsolation } from "./lib/smoke-connections.mjs";
import {
  httpServers,
  startCloudflareAccessProxy,
  startStaticServer,
  startWebhookReceiver,
} from "./lib/smoke-http.mjs";
import { installNativeWorkspace, VIEWPORT } from "./lib/smoke-native.mjs";
import {
  assertConnectionRefused,
  assertStopped,
  reservePort,
  startCoxServer,
  stopCoxServer,
} from "./lib/smoke-runtime.mjs";
import {
  exerciseDiff,
  exerciseNotifications,
  exerciseTerminal,
  signIn,
  visible,
} from "./lib/smoke-surfaces.mjs";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(mobileRoot, "../..");
const evidenceArg = process.argv.indexOf("--evidence-dir");
const evidenceTarget = resolve(
  (evidenceArg >= 0 ? process.argv[evidenceArg + 1] : undefined) ??
    process.env.COX_MOBILE_SMOKE_EVIDENCE_DIR ??
    join(repoRoot, ".omo/evidence"),
);
const screenshotsDir =
  basename(evidenceTarget) === "task-20-screenshots"
    ? evidenceTarget
    : join(evidenceTarget, "task-20-screenshots");
const evidenceDir = dirname(screenshotsDir);
const { chromium } = createRequire(join(mobileRoot, "package.json"))("playwright-core");
const scratchRoot = await mkdtemp(join(tmpdir(), "cox-mobile-e2e-"));
const children = [];
const pages = new Map();
const started = Date.now();
const report = {
  task: "task-20-mobile-client",
  startedAt: new Date(started).toISOString(),
  viewport: VIEWPORT,
  steps: [],
  screenshots: [],
  pageErrors: [],
  servers: {},
  paidTurns: 0,
};
let browser;
let failure;

async function shot(page, filename) {
  await mkdir(screenshotsDir, { recursive: true });
  await page.screenshot({ path: join(screenshotsDir, filename), animations: "disabled" });
  report.screenshots.push(filename);
}
function watchPage(page, label) {
  pages.set(label, page);
  page.on("pageerror", (error) => report.pageErrors.push({ page: label, message: error.message }));
}
async function step(name, run) {
  const entry = { name, outcome: "running" };
  report.steps.push(entry);
  try {
    const result = await run();
    entry.outcome = "passed";
    console.log("PASS:", name);
    return result;
  } catch (error) {
    entry.outcome = "failed";
    entry.error = String(error);
    throw error;
  }
}
function launch(server) {
  const entry = startCoxServer({ ...server, repoRoot });
  children.push(entry);
  return entry;
}

try {
  const servers = [];
  for (const [suffix, title] of [
    ["a", "Server-A-Mobile-Smoke-Thread"],
    ["b", "Server-B-Isolated-Thread"],
  ]) {
    const port = await reservePort();
    const server = {
      label: "Server " + suffix.toUpperCase(),
      home: join(scratchRoot, "home-" + suffix),
      repo: join(scratchRoot, "repo-" + suffix),
      title,
      password: "pw-server-" + suffix,
      port,
      origin: "http://127.0.0.1:" + port,
    };
    const entry = launch(server);
    servers.push(
      await step(
        "start and seed " + server.label + " with a persisted zero-turn thread",
        async () => {
          const descriptor = await entry.descriptor();
          const seeded = await seedThread({ ...server, environmentId: descriptor.environmentId });
          report.servers[server.label] = {
            origin: server.origin,
            environmentId: seeded.environmentId,
            threadId: seeded.threadId,
            projectId: seeded.projectId,
            pid: entry.child.pid,
          };
          return seeded;
        },
      ),
    );
  }
  const [serverA, serverB] = servers;
  assert.notEqual(serverA.environmentId, serverB.environmentId);
  const webhookPort = await reservePort();
  const webhook = {
    ...startWebhookReceiver(webhookPort),
    url: "http://127.0.0.1:" + webhookPort + "/hook",
  };
  await webhook.listening;
  const launcherPort = await reservePort();
  const launcherOrigin = "http://127.0.0.1:" + launcherPort;
  report.launcherOrigin = launcherOrigin;
  report.webhookOrigin = "http://127.0.0.1:" + webhookPort;
  const cfPort = await reservePort();
  const cfGateway = startCloudflareAccessProxy({
    port: cfPort,
    upstreamPort: serverA.port,
  });
  await cfGateway.listening;
  await startStaticServer(join(mobileRoot, "dist"), launcherPort);
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--host-resolver-rules=MAP cox.test 127.0.0.1,MAP team.cloudflareaccess.com 127.0.0.1",
    ],
  });
  report.chromium = browser.version();
  const launcherContext = await browser.newContext({
    viewport: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    ignoreHTTPSErrors: true,
  });
  const launcher = await launcherContext.newPage();
  watchPage(launcher, "launcher");
  const native = await installNativeWorkspace(launcher, browser, watchPage);
  await launcher.goto(launcherOrigin);
  for (const server of servers) {
    await step("add and pin " + server.label + " through the launcher", async () => {
      await addServer(launcher, server);
    });
  }
  await shot(launcher, "launcher-servers.png");
  const workspaceA = await step("Connect Server A invokes native navigation", () =>
    native.connect("Server A"),
  );
  await step("Server A chat displays its persisted thread without onboarding", async () => {
    await signIn(workspaceA, serverA);
    const pill = workspaceA.page.locator("[data-mobile-server-switcher]");
    assert.match(await pill.innerText(), /Server A\s+2/);
    await shot(workspaceA.page, "server-a-chat.png");
  });
  await step("live DiffPanel sheet renders the repository modification", () =>
    exerciseDiff(workspaceA.page, shot),
  );
  await step("live Ghostty touch keys send soft keyboard input to the shell PTY", () =>
    exerciseTerminal(workspaceA.page, serverA, shot),
  );
  await step("Bark notification reaches the local webhook receiver", () =>
    exerciseNotifications(workspaceA.page, webhook, shot),
  );
  report.webhookDeliveries = webhook.deliveries;
  await workspaceA.page.goto(
    new URL("/" + serverA.environmentId + "/" + serverA.threadId, serverA.origin).href,
  );
  await step("Servers pill returns control to launcher through the tokened bridge", () =>
    native.switchToLauncher(workspaceA),
  );
  const workspaceB = await step("Connect Server B invokes its isolated native workspace", () =>
    native.connect("Server B"),
  );
  await step("Server B has only its own thread, cookies, and storage", async () => {
    await assertServerIsolation([workspaceA, workspaceB], servers, shot);
  });
  await native.switchToLauncher(workspaceB);
  await step(
    "Cloudflare Access HTTPS server completes Add and connect with isolated gateway sign-in",
    async () => {
      const waitOpened = native.prepareOpenWait();
      await launcher.getByRole("button", { name: "Add server" }).click();
      await launcher.getByLabel("Display name").fill("CF Server A");
      await launcher.getByLabel("Server origin").fill(cfGateway.origin);
      await launcher.getByRole("button", { name: "Add and connect" }).click();
      const workspaceCf = await waitOpened();
      assert.equal(native.gatewayApprovals.length, 1);
      assert.equal(native.gatewayApprovals[0].origin, cfGateway.origin);
      await signIn(workspaceCf, { ...serverA, origin: cfGateway.origin });
      await workspaceCf.page
        .locator("[data-mobile-workspace-bar]")
        .getByRole("button", { name: "Threads", exact: true })
        .click();
      await visible(workspaceCf.page.getByText(serverA.title, { exact: true }).last());
      await workspaceCf.page.keyboard.press("Escape");
      await native.switchToLauncher(workspaceCf);
    },
  );
  await step("changed Server B identity blocks reconnect before native handoff", async () => {
    await stopCoxServer(children[1]);
    const identityFile = join(serverB.home, "userdata/environment-id");
    assert.equal((await readFile(identityFile, "utf8")).trim(), serverB.environmentId);
    await writeFile(identityFile, crypto.randomUUID());
    const replacement = launch(serverB);
    const descriptor = await replacement.descriptor();
    assert.notEqual(descriptor.environmentId, serverB.environmentId);
    await launcher
      .getByRole("listitem")
      .filter({ hasText: "Server B" })
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await visible(
      launcher
        .getByTestId("connection-error")
        .filter({ hasText: "The server identity changed. Connecting is blocked." }),
    );
    await launcher.getByTestId("connection-error").scrollIntoViewIfNeeded();
    await shot(launcher, "launcher-identity-block.png");
    report.changedEnvironmentId = descriptor.environmentId;
  });
  assert.deepEqual(report.pageErrors, []);
  report.outcome = "passed";
} catch (error) {
  failure = error;
  report.outcome = "failed";
  console.error(error);
  for (const [label, page] of pages) {
    console.error(label, page.url(), await page.locator("body").innerText());
    await shot(page, "failure-" + label.replaceAll(" ", "-") + ".png");
  }
} finally {
  if (browser) await browser.close();
  for (const { server } of httpServers) await new Promise((resolve) => server.close(resolve));
  for (const entry of children.toReversed()) await stopCoxServer(entry);
  for (const entry of children) await assertStopped(entry);
  for (const origin of new Set(
    [...children.map((entry) => entry.origin), report.launcherOrigin, report.webhookOrigin].filter(
      Boolean,
    ),
  ))
    await assertConnectionRefused(origin);
  report.teardown = "verified";
  await rm(scratchRoot, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.durationMs = Date.now() - started;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(
    join(evidenceDir, "task-20-mobile-client.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
}
if (failure) process.exitCode = 1;
else
  console.log(
    "PASS: live mobile handoff, seven surfaces, isolation, identity pinning, and teardown.",
  );
