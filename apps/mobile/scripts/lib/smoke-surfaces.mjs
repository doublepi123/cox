import assert from "node:assert/strict";
import { watch } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withDeadline } from "./smoke-runtime.mjs";

export const visible = (locator) => locator.waitFor({ state: "visible", timeout: 60_000 });

export const threadsButton = (page) =>
  page.getByRole("button", { name: "Toggle main sidebar", exact: true });

export const changesButton = (page) =>
  page.getByRole("button", { name: "Toggle right panel", exact: true });

export const terminalButton = (page) =>
  page.getByRole("button", { name: "Toggle terminal drawer", exact: true });

export async function assertPhoneLayout(page) {
  assert.equal(await page.getByText("Connect your agents", { exact: true }).count(), 0);
  assert.ok(
    await page.evaluate(() => document.documentElement.scrollWidth <= 390),
    "Workspace must fit the 390px viewport.",
  );
}

export async function signIn(workspace, server) {
  const page = workspace.page;
  await page.getByLabel("Password", { exact: true }).fill(server.password);
  await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/api/auth/browser-session") && res.ok(), {
      timeout: 20_000,
    }),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await page.goto(new URL(`/${server.environmentId}/${server.threadId}`, server.origin).href);
  await visible(threadsButton(page));
  await visible(page.getByText(server.title, { exact: true }).first());
  await visible(page.getByText("Send a message to start the conversation.", { exact: true }));
  for (const dismiss of await page.getByRole("button", { name: /Dismiss .* provider/ }).all()) {
    await dismiss.click();
  }
  await assertPhoneLayout(page);
}

export async function exerciseDiff(page, shot) {
  await changesButton(page).click();
  const sheet = page.getByRole("dialog");
  await visible(sheet);
  const expand = sheet.getByRole("button", { name: "Expand hello.ts", exact: true });
  if ((await expand.count()) === 0) {
    await sheet.getByRole("button", { name: "Add panel surface", exact: true }).click();
    await page.getByRole("menuitem", { name: "Diff", exact: true }).click();
  }
  await expand.click();
  await visible(sheet.getByText("export const v = 2", { exact: false }).first());
  await assertPhoneLayout(page);
  await shot(page, "server-a-diff.png");
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
}

export async function exerciseTerminal(page, server, shot) {
  await terminalButton(page).click();
  const drawer = page.locator("[data-thread-terminal-drawer]");
  await visible(drawer.locator("canvas"));
  const input = drawer.locator("textarea[data-workspace-focus-default]");
  await input.waitFor({ state: "attached", timeout: 60_000 });
  const keys = drawer.getByRole("toolbar", { name: "Terminal keys" });
  await visible(keys);
  const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
  await ctrl.click();
  assert.equal(await ctrl.getAttribute("aria-pressed"), "true");
  await input.focus();
  await page.keyboard.insertText("c");
  await keys.locator('[aria-label="Ctrl"][aria-pressed="false"]').waitFor();
  const marker = "COX_MOBILE_PTY_OK";
  const outputFile = "terminal-smoke.txt";
  const outputReady = Promise.withResolvers();
  const watcher = watch(server.repo, (_, filename) => {
    if (filename === outputFile) outputReady.resolve();
  });
  try {
    await input.focus();
    await page.keyboard.insertText(
      `printf '${marker}\\n' | tee terminal-smoke.tmp; mv terminal-smoke.tmp ${outputFile}`,
    );
    await input.press("Enter");
    await withDeadline(outputReady.promise, 20_000, "Soft keyboard never reached the live PTY.");
    assert.equal(await readFile(join(server.repo, outputFile), "utf8"), `${marker}\n`);
  } finally {
    watcher.close();
  }
  await input.blur();
  await ctrl.click();
  assert.equal(await ctrl.getAttribute("aria-pressed"), "true");
  await assertPhoneLayout(page);
  await shot(page, "server-a-terminal.png");
  await terminalButton(page).click();
  await drawer.waitFor({ state: "hidden" });
}

export async function exerciseNotifications(page, webhook, shot) {
  await page.goto(new URL("/settings/notifications", page.url()).href);
  await page.getByRole("button", { name: "Add Webhook" }).click();
  const editor = page.locator("form").last();
  await editor.getByRole("combobox").first().click();
  await page.getByRole("option", { name: "Bark", exact: true }).click();
  await editor.getByLabel("Channel name").fill("Smoke Bark");
  await editor.getByLabel(/URL/).fill(webhook.url);
  await editor.getByRole("checkbox", { name: "Allow private network HTTP" }).click();
  await editor.getByRole("button", { name: "Add channel" }).click();
  await visible(page.getByText("Smoke Bark"));
  const delivery = webhook.waitForDelivery();
  await page.getByRole("button", { name: "Send Test", exact: true }).click();
  await withDeadline(delivery, 30_000, "The Bark test never reached the loopback receiver.");
  assert.equal(webhook.deliveries.length, 1);
  const body = JSON.parse(webhook.deliveries[0].body);
  assert.ok(body.title);
  assert.ok(body.body);
  await assertPhoneLayout(page);
  await shot(page, "server-a-notifications.png");
}
