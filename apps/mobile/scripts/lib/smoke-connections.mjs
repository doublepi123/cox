import assert from "node:assert/strict";
import { readThreadFamily } from "./smoke-fixtures.mjs";
import { assertPhoneLayout, signIn, threadsButton, visible } from "./smoke-surfaces.mjs";

export async function addServer(launcher, server) {
  await launcher.getByRole("button", { name: "Add server" }).click();
  await launcher.getByLabel("Display name").fill(server.label);
  await launcher.getByLabel("Server origin").fill(server.origin);
  await launcher
    .getByRole("checkbox", {
      name: "Allow password-protected plain HTTP on trusted LAN/Tailscale",
    })
    .click();
  await launcher.getByRole("button", { name: "Verify and save" }).click();
  await visible(launcher.getByRole("listitem").filter({ hasText: server.label }));
  const profiles = await launcher.evaluate(
    () => JSON.parse(localStorage.getItem("cox.mobile.connections.v1")).profiles,
  );
  assert.equal(
    profiles.find((profile) => profile.origin === server.origin).pinnedEnvironmentId,
    server.environmentId,
  );
}

export async function assertServerIsolation(workspaces, servers, shot) {
  const [workspaceA, workspaceB] = workspaces;
  const [serverA, serverB] = servers;
  await signIn(workspaceB, serverB);
  const cookiesA = new Set((await workspaceA.context.cookies()).map((cookie) => cookie.value));
  for (const cookie of await workspaceB.context.cookies()) assert.ok(!cookiesA.has(cookie.value));
  const storage = await workspaceB.page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!storage.includes(serverA.environmentId));
  assert.ok(!storage.includes(serverA.threadId));
  const projects = await workspaceB.page.evaluate(async () =>
    (await fetch("/api/projects")).json(),
  );
  assert.ok(JSON.stringify(projects).includes(serverB.projectId));
  assert.ok(!JSON.stringify(projects).includes(serverA.projectId));
  await threadsButton(workspaceB.page).click();
  await visible(workspaceB.page.getByText(serverB.title, { exact: true }).last());
  assert.equal(await workspaceB.page.getByText(serverA.title, { exact: true }).count(), 0);
  const ownFamily = await readThreadFamily(serverB, serverB.threadId);
  assert.deepEqual(
    ownFamily.threads.map((thread) => thread.title),
    [serverB.title],
  );
  const foreignFamily = await readThreadFamily(serverB, serverA.threadId);
  assert.deepEqual(foreignFamily.threads, []);
  await assertPhoneLayout(workspaceB.page);
  await shot(workspaceB.page, "server-b-workspace.png");
  await workspaceB.page.keyboard.press("Escape");
}
