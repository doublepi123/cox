import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DesktopComputerUseState } from "@t3tools/contracts";
import { ComputerExecutor, permissionState, USER_PAUSE_LIMIT_MS } from "./executor.ts";
import {
  computerEngineAsset,
  computerStopChord,
  EngineClient,
  engineCachePaths,
  openEngine,
} from "./engine.ts";
import { createComputerOverlayPage } from "./overlay-page.ts";

const directories: string[] = [];
async function fakeEngine(script: string) {
  const directory = await mkdtemp(join(tmpdir(), "cox-computer-engine-"));
  directories.push(directory);
  const source = join(directory, "engine.cjs");
  await writeFile(source, script);
  return new EngineClient(process.execPath, [source]);
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
  it("treats unavailable Windows input as denied", () => {
    expect(
      permissionState(
        { capturePermission: "granted", axPermission: "granted", inputPermission: "unavailable" },
        true,
      ),
    ).toEqual({ screenRecording: "granted", accessibility: "granted", input: "denied" });
  });
  it("selects the engine build, cache file and stop chord for each platform", () => {
    expect(computerEngineAsset("win32", "x64")).toBe("senpi-desktop-engine-win32-x64.exe");
    expect(computerEngineAsset("win32", "arm64")).toBe("senpi-desktop-engine-win32-arm64.exe");
    expect(computerEngineAsset("darwin", "arm64")).toBe("senpi-desktop-engine-darwin-arm64");
    expect(engineCachePaths("home", "v1", "win32", "x64")[0]).toBe(
      join("home", "computer-engine", "v1", "win32-x64", "senpi-desktop-engine.exe"),
    );
    expect(engineCachePaths("home", "v1", "darwin", "x64")[0]).toBe(
      join("home", "computer-engine", "v1", "darwin-x64", "senpi-desktop-engine"),
    );
    expect(computerStopChord("win32")).toBe("ctrl+alt+shift+escape");
    expect(computerStopChord("darwin")).toBe("ctrl+alt+cmd+escape");
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
  it("maps a macOS PermissionDenied to missing permissions", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'permission'}})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state("denied"),
      platform: "darwin",
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
  it("reports a Windows PermissionDenied as an administrator app refusal", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'elevated'}})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
      platform: "win32",
    });
    const refused = executor.execute({
      threadId: "t",
      threadTitle: "Thread",
      agent: "Agent",
      action: { kind: "type", windowId: "w", text: "x" },
    });
    await expect(refused).rejects.toMatchObject({
      code: "permission",
      recovery: "Run that app without administrator rights, or start Cox as administrator.",
    });
    await expect(refused).rejects.not.toHaveProperty("missing");
    await client.close();
  });
  it("uses foreground delivery only for windows the user approved in that thread", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{method:m.method,params:m.params}})+'\\n')});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
    });
    const run = (threadId: string, action: Parameters<ComputerExecutor["execute"]>[0]["action"]) =>
      executor.execute({ threadId, threadTitle: "Thread", agent: "Agent", action });
    await expect(run("a", { kind: "type", windowId: "w", text: "x" })).resolves.toMatchObject({
      params: { opts: { deliveryMode: "background" } },
    });
    await expect(
      run("a", { kind: "foreground", windowId: "w", reason: "Background input was refused" }),
    ).resolves.toEqual({ method: "raiseWindow", params: { windowId: "w" } });
    await expect(run("a", { kind: "type", windowId: "w", text: "x" })).resolves.toMatchObject({
      params: { opts: { deliveryMode: "foreground" } },
    });
    await expect(run("b", { kind: "type", windowId: "w", text: "x" })).resolves.toMatchObject({
      params: { opts: { deliveryMode: "background" } },
    });
    await executor.threadEvent("a", "completed");
    await expect(run("a", { kind: "type", windowId: "w", text: "x" })).resolves.toMatchObject({
      params: { opts: { deliveryMode: "background" } },
    });
    await client.close();
  });
  it("opens the engine session without the virtual cursor overlay", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-computer-engine-"));
    directories.push(directory);
    const source = join(directory, "engine.cjs");
    await writeFile(
      source,
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);const result=m.method==='engine.hello'?{abi:'senpi-desktop/1',protocolVersion:'1'}:{resumeToken:'token',capabilities:m.params};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
    );
    const opened = await openEngine(process.execPath, [source]);
    expect(opened.capabilities).toEqual({ showCursor: false });
    expect(opened.resumeToken).toBe("token");
    await opened.client.close();
  });
  it("traces element action, role, delivery and key window without typed text", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});let windows=0;rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=null;if(m.method==='windows'){windows++;result=[{id:'1',app:windows<2?'Safari':'Google Chrome',pid:windows<2?10:20,title:'Secret page',focused:true},{id:'2',app:'Other',pid:30,title:'x',focused:false}]}if(m.method==='ax.query')result=[{ref:'e7',role:'AXTextField'}];process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});`,
    );
    const entries: unknown[] = [];
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
      trace: (entry) => entries.push(entry),
    });
    const run = (action: Parameters<ComputerExecutor["execute"]>[0]["action"]) =>
      executor.execute({ threadId: "t", threadTitle: "Thread", agent: "Codex", action });
    await run({ kind: "uiTree", windowId: "1", role: "AXTextField" });
    await run({ kind: "element", ref: "e7", action: "typeText", value: "private words" });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      threadId: "t",
      agent: "Codex",
      kind: "element",
      elementAction: "typeText",
      role: "AXTextField",
      keyWindowBefore: { app: "Safari", pid: 10, windowId: "1" },
      keyWindowAfter: { app: "Google Chrome", pid: 20, windowId: "1" },
      outcome: "ok",
    });
    expect(JSON.stringify(entries)).not.toMatch(/private words|Secret page/);
    await client.close();
  });
  it("holds background input while the user is active and sends nothing", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='windows'?[]:m.method})+'\\n')});`,
    );
    let idle = 0;
    let waits = 0;
    const steps: string[] = [];
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: (input) => steps.push(input.step),
      refreshState: async () => state(),
      userIdleMs: () => idle,
      wait: async () => {
        waits += 1;
        if (waits === 3) idle = 1_500;
      },
    });
    const run = (action: Parameters<ComputerExecutor["execute"]>[0]["action"]) =>
      executor.execute({ threadId: "t", threadTitle: "Thread", agent: "Agent", action });
    await expect(run({ kind: "windows" })).resolves.toEqual([]);
    expect(waits).toBe(0);
    await expect(run({ kind: "type", windowId: "w", text: "x" })).resolves.toBe("typeText");
    expect(waits).toBe(3);
    expect(steps).toContain("waiting-user");
    idle = 0;
    waits = 0;
    const busy = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
      userIdleMs: () => idle,
      wait: async () => {
        waits += 1;
      },
    });
    await expect(
      busy.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "element", ref: "e1", action: "press" },
      }),
    ).rejects.toMatchObject({ code: "background-unavailable" });
    expect(waits).toBe(USER_PAUSE_LIMIT_MS / 250);
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
