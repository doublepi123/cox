import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DesktopComputerUseState } from "@t3tools/contracts";
import { ComputerExecutor, permissionState } from "./executor.ts";
import { EngineClient } from "./engine.ts";
import { createComputerOverlayPage } from "./overlay-page.ts";

const directories: string[] = [];
async function fakeEngine(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "cox-computer-engine-"));
  directories.push(directory);
  const executable = join(directory, "engine");
  await writeFile(executable, `#!/usr/bin/env node\n${script}`);
  await chmod(executable, 0o755);
  return new EngineClient(executable);
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

const state = (
  permission: "granted" | "denied" | "unknown" = "granted",
): DesktopComputerUseState => ({
  supported: true,
  enabled: true,
  engine: "ready",
  engineMessage: null,
  permissions: { screenRecording: permission, accessibility: permission, input: permission },
  appName: "Cox",
  appPath: null,
  macosVersion: null,
  restartRequired: false,
  stopped: false,
  ready: permission === "granted",
});

describe("desktop computer host", () => {
  it("requires a live global stop listener for input permission", () => {
    expect(
      permissionState(
        { capturePermission: "granted", axPermission: "granted", inputPermission: "granted" },
        false,
      ),
    ).toEqual({ screenRecording: "granted", accessibility: "granted", input: "denied" });
  });
  it("keeps the stop latch until explicit resume", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:null})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
    });
    await executor.stop();
    await expect(
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "click", windowId: "w", x: 1, y: 1 },
      }),
    ).rejects.toMatchObject({ code: "stopped" });
    await executor.resume();
    await expect(
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "click", windowId: "w", x: 1, y: 1 },
      }),
    ).resolves.toBeNull();
    await client.close();
  });
  it("maps PermissionDenied to missing permissions", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'permission'}})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state("denied"),
    });
    await expect(
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "click", windowId: "w", x: 1, y: 1 },
      }),
    ).rejects.toMatchObject({
      code: "permission",
      missing: ["screenRecording", "accessibility", "input"],
    });
    await client.close();
  });
  it("cancels only the stopped thread's active and queued actions", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});const timers=new Map();rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='$/cancel'){const timer=timers.get(m.params.id);if(timer){clearTimeout(timer);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.params.id,error:{code:-32017,message:'cancelled'}})+'\\n')}return}if(m.id!==undefined){const timer=setTimeout(()=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:null})+'\\n'),100);timers.set(m.id,timer)}});`,
    );
    let running!: () => void;
    const began = new Promise<void>((resolve) => {
      running = resolve;
    });
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: (input) => {
        if (input.threadId === "a") running();
      },
      refreshState: async () => state(),
    });
    const first = executor.execute({
      threadId: "a",
      threadTitle: "A",
      agent: "Agent",
      action: { kind: "click", windowId: "w", x: 1, y: 1 },
    });
    await began;
    const second = executor.execute({
      threadId: "a",
      threadTitle: "A",
      agent: "Agent",
      action: { kind: "click", windowId: "w", x: 2, y: 2 },
    });
    const other = executor.execute({
      threadId: "b",
      threadTitle: "B",
      agent: "Agent",
      action: { kind: "click", windowId: "w", x: 3, y: 3 },
    });
    executor.cancelThread("a");
    await expect(first).rejects.toMatchObject({ code: "cancelled" });
    await expect(second).rejects.toMatchObject({ code: "cancelled" });
    await expect(other).resolves.toBeNull();
    await client.close();
  });
  it("returns declined when foreground confirmation is rejected", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:null})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => false,
      showOperation: () => {},
      refreshState: async () => state(),
    });
    await expect(
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "foreground", windowId: "w", reason: "Needs focus" },
      }),
    ).rejects.toMatchObject({ code: "declined" });
    await client.close();
  });
  it("renders every overlay operation state", () => {
    for (const value of [
      "operating",
      "waiting-model",
      "waiting-confirmation",
      "completed",
      "failed",
      "stopped",
    ] as const) {
      const html = createComputerOverlayPage("en", {
        threadId: "thread",
        environmentId: "env",
        threadTitle: "Title",
        agent: "Agent",
        step: "Typing",
        state: value,
      });
      expect(html).toContain(`data-state="${value}"`);
      expect(html).toContain(
        value === "stopped" ? "Resume" : value === "failed" ? "Settings" : "Stop",
      );
    }
  });
});
