import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { DesktopComputerUseState } from "@t3tools/contracts";
import {
  ComputerExecutor,
  permissionState,
  USER_PAUSE_LIMIT_MS,
  WINDOW_SETTLE_MS,
} from "./executor.ts";
import {
  ComputerEngineExitError,
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
  it("reports the engine's launch refusal and logs its stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-computer-engine-"));
    directories.push(directory);
    const source = join(directory, "engine.cjs");
    await writeFile(
      source,
      `process.stderr.write('SENPI_DESKTOP_LAUNCH_REFUSED {"version":1,"reason":"self-responsible"}\\n');process.stderr.write('senpi-desktop-engine: refusing to run as its own responsible process (pid 7)\\n');process.exitCode=1;`,
    );
    const logged: string[] = [];
    const failure = await openEngine(process.execPath, [source], {
      onStderr: (line) => logged.push(line),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ComputerEngineExitError);
    expect(failure).toMatchObject({
      launchRefusal: "self-responsible",
      message:
        "Computer engine refused to start (self-responsible): senpi-desktop-engine: refusing to run as its own responsible process (pid 7)",
    });
    expect(logged).toEqual([
      'SENPI_DESKTOP_LAUNCH_REFUSED {"version":1,"reason":"self-responsible"}',
      "senpi-desktop-engine: refusing to run as its own responsible process (pid 7)",
    ]);
  });
  it("keeps the engine's last stderr line when it exits without a launch refusal", async () => {
    const client = await fakeEngine(
      `process.stderr.write('engine: capture backend failed\\n');process.exitCode=3;`,
    );
    const closed = new Promise<Error>((resolve) => client.onClose(resolve));
    expect((await closed).message).toBe(
      "Computer engine exited (3): engine: capture backend failed",
    );
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
      platform: "linux",
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
  it("asks once, raises the window and sends foreground input when a call requests it", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{method:m.method,params:m.params}})+'\\n')});`,
    );
    const confirmations: string[] = [];
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async ({ windowId }) => {
        confirmations.push(windowId);
        return windowId !== "refused";
      },
      showOperation: () => {},
      refreshState: async () => state(),
    });
    const run = (action: Parameters<ComputerExecutor["execute"]>[0]["action"]) =>
      executor.execute({ threadId: "t", threadTitle: "Thread", agent: "Agent", action });
    await expect(
      run({ kind: "press", windowId: "w", keys: ["cmd", "s"], delivery: "foreground" }),
    ).resolves.toEqual({
      method: "keyChord",
      params: { target: "w", keys: ["cmd", "s"], opts: { deliveryMode: "foreground" } },
    });
    await expect(
      run({ kind: "type", windowId: "w", text: "x", delivery: "foreground" }),
    ).resolves.toMatchObject({ params: { opts: { deliveryMode: "foreground" } } });
    expect(confirmations).toEqual(["w"]);
    await expect(
      run({ kind: "type", windowId: "w", text: "x", delivery: "background" }),
    ).resolves.toMatchObject({ params: { opts: { deliveryMode: "background" } } });
    await expect(
      run({ kind: "press", windowId: "refused", keys: ["escape"], delivery: "foreground" }),
    ).rejects.toMatchObject({ code: "declined" });
    expect(confirmations).toEqual(["w", "refused"]);
    await client.close();
  });
  it("revokes every thread's foreground windows with the shared engine grant", async () => {
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
    await run("a", { kind: "foreground", windowId: "w", reason: "Needs keys" });
    await executor.threadEvent("b", "completed");
    await expect(run("a", { kind: "type", windowId: "w", text: "x" })).resolves.toMatchObject({
      params: { opts: { deliveryMode: "background" } },
    });
    await client.close();
  });
  it.each([
    [
      -32003,
      'window 56556 is one of 2 windows in its application; macOS delivers background keystrokes to whichever window the application treats as key, so retry with delivery:"foreground" or use ax actions',
      "background-unavailable",
      'delivery:"foreground"',
    ],
    [-32004, "window '999999' was not found; it may be closed", "not-found", "computer_windows"],
    [-32007, "frame f1 is stale", "stale-frame", "computer_screenshot"],
    [-32008, "ref e4 is stale", "stale-ref", "computer_ui_tree"],
    [
      -32010,
      "accessibility window for native window 56582 ('') was not found",
      "ax-not-found",
      "computer_click",
    ],
    [-32010, "AXPress failed", "ax-action-failed", "computer_ui_tree"],
    [-32009, "AXPress is not supported", "ax-unsupported", "computer_press"],
    [-32024, "the user was typing", "user-intervened", "never repeat"],
  ] as const)(
    "reports engine error %i as a specific failure with its own recovery",
    async (engineCode, message, code, recovery) => {
      const client = await fakeEngine(
        `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:${engineCode},message:${JSON.stringify(message)}}})+'\\n')});`,
      );
      const executor = new ComputerExecutor(client, "resume", {
        state: () => state(),
        confirmForeground: async () => true,
        showOperation: () => {},
        refreshState: async () => state(),
      });
      const failure = executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "press", windowId: "w", keys: ["escape"] },
      });
      await expect(failure).rejects.toMatchObject({ code, message });
      await expect(failure).rejects.toMatchObject({
        recovery: expect.stringContaining(recovery),
      });
      await expect(failure).rejects.not.toMatchObject({
        recovery: expect.stringContaining("Labs"),
      });
      await client.close();
    },
  );
  it("names the engine state when computer control is not ready without missing permissions", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',()=>{});`,
    );
    const executor = new ComputerExecutor(client, "resume", {
      state: () => ({ ...state(), engine: "error", ready: false }),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
    });
    await expect(
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "type", windowId: "w", text: "x" },
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: expect.stringContaining("engine: error"),
      recovery: expect.stringContaining("Re-check"),
    });
    await client.close();
  });
  it("lets settled macOS windows be filtered by bundle id or English bundle name", async () => {
    const client = await fakeEngine(
      `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:[{id:'1',app:'\u6587\u672c\u7f16\u8f91',pid:10,title:'Notes'},{id:'2',app:'\u8ba1\u7b97\u5668',pid:20,title:''}]})+'\\n')});`,
    );
    const waits: number[] = [];
    const executor = new ComputerExecutor(client, "resume", {
      state: () => state(),
      confirmForeground: async () => true,
      showOperation: () => {},
      refreshState: async () => state(),
      platform: "darwin",
      wait: async (ms) => {
        waits.push(ms);
      },
      appIdentity: async (pid) =>
        pid === 10
          ? { bundleId: "com.apple.TextEdit", name: "TextEdit" }
          : { bundleId: "com.apple.calculator", name: "Calculator" },
    });
    const windows = (app: string) =>
      executor.execute({
        threadId: "t",
        threadTitle: "Thread",
        agent: "Agent",
        action: { kind: "windows", app },
      });
    await expect(windows("TextEdit")).resolves.toEqual([
      {
        id: "1",
        app: "\u6587\u672c\u7f16\u8f91",
        pid: 10,
        title: "Notes",
        bundleId: "com.apple.TextEdit",
        bundleName: "TextEdit",
      },
    ]);
    await expect(windows("com.apple.calc")).resolves.toMatchObject([{ id: "2" }]);
    await expect(windows("\u6587\u672c")).resolves.toMatchObject([{ id: "1" }]);
    expect(waits).toEqual([WINDOW_SETTLE_MS, WINDOW_SETTLE_MS, WINDOW_SETTLE_MS]);
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
