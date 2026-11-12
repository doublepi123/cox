// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it } from "vite-plus/test";
import { PI_T3_MCP_EXTENSION_SOURCE } from "@t3tools/provider-pi/server";
import { OMO_EXTENSION_SOURCE, buildOmoLaunch } from "./extension.ts";
import { OMO_RUNTIME_ASSETS_SOURCE } from "./runtimeAssets.ts";
import { omoTaskConfiguration } from "./configuration.ts";
import { OmoSettings } from "../settings.ts";
import * as Schema from "effect/Schema";

type RpcRecord = Record<string, unknown>;

const probe = String.raw`
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { loadCoxOmoRuntimeAssets } from "./runtime-assets.mjs";
import * as sdk from "@code-yeongyu/senpi";

export default async function probe(pi) {
  const runtime = await loadCoxOmoRuntimeAssets({ sdk });
  let context;
  let child;
  let readChildPreset;
  pi.on("session_start", (_event, ctx) => { context = ctx; });
  pi.on("session_shutdown", () => child?.dispose());
  pi.rpc.handle("cox.assets.child", async () => {
    const settingsManager = sdk.SettingsManager.inMemory({ enabledBuiltinExtensions: ["permission-system"], permissionPreset: "full-access" });
    const loader = new sdk.DefaultResourceLoader({ cwd: context.cwd, agentDir: context.agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [api => { api.on("session_start", () => { readChildPreset = () => api.getPermissionPreset(); }); }] });
    await loader.reload();
    const id = context.sessionManager.getSessionId();
    child = (await sdk.createAgentSession({ cwd: context.cwd, agentDir: context.agentDir, settingsManager,
      resourceLoader: loader, modelRegistry: context.modelRegistry, tools: ["write"],
      sessionManager: sdk.SessionManager.inMemory(context.cwd, { spawnedBy: { parentSessionId: id, rootSessionId: id, taskId: "no-model-write" } }) })).session;
    await child.bindExtensions({ mode: "print" });
    return { kind: runtime.kind, parent: pi.getPermissionPreset(), child: readChildPreset(), errors: loader.getExtensions().errors };
  });
  pi.rpc.handle("cox.assets.write", async data => {
    const filename = join(context.cwd, "child-write.txt");
    const before = await readFile(filename, "utf8").catch(() => null);
    const call = { type: "toolCall", id: crypto.randomUUID(), name: "write", arguments: { path: filename, content: data.content } };
    const gate = await child.preflightToolCall(call, call.arguments, { waitForEventQueue: false });
    if (gate?.block !== true) await sdk.createWriteTool(context.cwd).execute(call.id, call.arguments, new AbortController().signal);
    return { parent: pi.getPermissionPreset(), child: readChildPreset(), blocked: gate?.block === true,
      before, after: await readFile(filename, "utf8").catch(() => null) };
  });
  pi.rpc.handle("cox.assets.scoped", async () => {
    if (!runtime.loadModules) return { available: false };
    const entryUrl = runtime.resolveModule("omo.js");
    const taskUrl = runtime.resolveModule("omo-task.js");
    const entry = 'import { SessionManager } from "@code-yeongyu/senpi"; export { SessionManager }; export const sidecar = () => import("#omo-task-runtime"); export const blocked = () => import("#omo-memory-sync-runtime"); export const computed = path => import(path); export const where = import.meta.url;';
    const load = () => runtime.loadModules({ entryUrl, modules: new Map([
      [entryUrl, { name: "omo.js", source: entry }],
      [taskUrl, { name: "omo-task.js", source: 'export const marker = "transformed-fixture";' }],
    ]), aliases: { "#omo-task-runtime": "omo-task.js" }, blockedImports: ["#omo-memory-sync-runtime"] });
    const first = await load();
    const second = await load();
    let blocked = false;
    let computedBlocked = false;
    try { await first.blocked(); } catch { blocked = true; }
    try { await first.computed("@code-yeongyu/senpi"); } catch { computedBlocked = true; }
    const sidecar = await first.sidecar();
    first.dispose();
    second.dispose();
    return { available: true, identity: first.SessionManager === sdk.SessionManager, blocked, computedBlocked,
      distinct: first !== second && first.sidecar !== second.sidecar, where: first.where, sidecar };
  });
}
`;

const record = (value: unknown): RpcRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as RpcRecord) : {};

const decodeOmoSettings = Schema.decodeSync(OmoSettings);
const standalone = process.env.COX_OMO_STANDALONE_TEST_BINARY;
const npm = process.env.COX_OMO_NPM_TEST_LAUNCHER;

describe("official OMO no-model runtime layout acceptance", () => {
  for (const fixture of [
    { kind: "standalone", executable: standalone },
    { kind: "npm", executable: npm },
  ] as const) {
    it.runIf(fixture.executable !== undefined)(
      `${fixture.kind}: final extension startup and live child write downgrades`,
      async () => {
        if (fixture.executable === undefined)
          throw new Error("An isolated official OMO fixture is required.");
        if (fixture.kind === "standalone") {
          const hash = createHash("sha256")
            .update(await NodeFS.readFile(fixture.executable))
            .digest("hex");
          expect(hash).toBe("3a74aba613cf02e740073b302171c0fb9d9155f5ff6069f91bea23972ffa1444");
        }
        const temporary = await NodeFS.mkdtemp(
          NodePath.join(NodeOS.homedir(), ".cache", "cox-omo-assets-native-"),
        );
        const home = NodePath.join(temporary, "home");
        const agent = NodePath.join(temporary, "agent");
        const cwd = NodePath.join(temporary, "project");
        for (const directory of [home, agent, cwd]) await NodeFS.mkdir(directory, { mode: 0o700 });
        const config = omoTaskConfiguration(
          decodeOmoSettings({ automaticMemory: false }),
          NodePath.join(agent, "tasks"),
        );
        await Promise.all([
          NodeFS.writeFile(NodePath.join(temporary, "cox-extension.ts"), OMO_EXTENSION_SOURCE),
          NodeFS.writeFile(
            NodePath.join(temporary, "pi-t3-mcp-extension.ts"),
            PI_T3_MCP_EXTENSION_SOURCE,
          ),
          NodeFS.writeFile(
            NodePath.join(temporary, "runtime-assets.mjs"),
            `${OMO_RUNTIME_ASSETS_SOURCE}\nexport { loadCoxOmoRuntimeAssets };`,
          ),
          NodeFS.writeFile(NodePath.join(temporary, "probe.ts"), probe),
          NodeFS.writeFile(
            NodePath.join(agent, "settings.json"),
            JSON.stringify({ enabledBuiltinExtensions: ["permission-system"] }),
          ),
        ]);
        const enabledMemory = process.env.COX_OMO_ASSET_TEST_MEMORY === "1";
        const launch = buildOmoLaunch({
          launchArgs: [
            "--no-extensions",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--extension",
            NodePath.join(temporary, "probe.ts"),
          ],
          environment: {
            HOME: home,
            USERPROFILE: home,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            XDG_CONFIG_HOME: home,
            XDG_CACHE_HOME: home,
            OMO_CODING_AGENT_DIR: agent,
            SENPI_CODING_AGENT_DIR: agent,
            OMO_RUNTIME: "node",
            COX_OMO_AUTOMATIC_MEMORY: enabledMemory ? "1" : "0",
            COX_OMO_MEMORY_HOME: NodePath.join(temporary, "memory"),
            COX_OMO_TASK_CONFIG: JSON.stringify(config),
            CI: "1",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: NodePath.join(temporary, "gitconfig"),
          },
          mcpSession: undefined,
          extensionPath: NodePath.join(temporary, "cox-extension.ts"),
          runtimeMode: "approval-required",
        });
        const child = spawn(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            "process.umask(0o077); process.execve(process.argv[1], process.argv.slice(1), process.env);",
            ...(fixture.kind === "npm"
              ? [process.execPath, fixture.executable]
              : [fixture.executable]),
            ...launch.args,
          ],
          {
            cwd,
            env: launch.env,
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        const pending = new Map<
          string,
          { resolve: (reply: RpcRecord) => void; reject: (error: Error) => void }
        >();
        const lines = createInterface({ input: child.stdout });
        lines.on("line", (line) => {
          try {
            const reply = record(JSON.parse(line));
            if (reply.type !== "response" || typeof reply.id !== "string") return;
            const waiter = pending.get(reply.id);
            pending.delete(reply.id);
            waiter?.resolve(reply);
          } catch {}
        });
        const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
        child.on("exit", () => {
          for (const waiter of pending.values())
            waiter.reject(new Error(`OMO fixture exited: ${stderr}`));
          pending.clear();
        });
        let sequence = 0;
        const request = async (command: RpcRecord) => {
          const id = `assets-${++sequence}`;
          const promise = new Promise<RpcRecord>((resolve, reject) =>
            pending.set(id, { resolve, reject }),
          );
          child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
          const response = await promise;
          expect(response.success, `${String(response.error)}\n${stderr}`).toBe(true);
          return record(response.data);
        };
        try {
          const ready = await request({
            type: "extension_request",
            name: "cox.omo.ready",
            data: {},
          });
          expect(ready).toMatchObject({
            ready: true,
            available: true,
            nativeTaskReady: true,
            nativeTask: { status: "active" },
          });
          expect(
            await request({ type: "set_permission_preset", permissionPreset: "ask" }),
          ).toMatchObject({
            permissionPreset: "ask",
            permissionPresetSource: "client",
            permissionPresetStatus: "applied",
          });
          const childState = await request({
            type: "extension_request",
            name: "cox.assets.child",
            data: {},
          });
          expect(childState).toMatchObject({ kind: fixture.kind, child: "ask", errors: [] });
          let previous: unknown = null;
          for (const preset of ["full-access", "ask", "accept-edits", "ask"]) {
            const applied = await request({
              type: "set_permission_preset",
              permissionPreset: preset,
            });
            expect(applied).toMatchObject({
              permissionPreset: preset,
              permissionPresetSource: "client",
              permissionPresetStatus: "applied",
            });
            const state = await request({ type: "get_state" });
            expect(state).toMatchObject({
              effectivePermissionPreset: preset,
              messageCount: 0,
              usageTotals: { cost: 0 },
            });
            const write = await request({
              type: "extension_request",
              name: "cox.assets.write",
              data: { content: preset },
            });
            expect(write).toMatchObject({
              parent: preset,
              child: preset,
              blocked: preset === "ask",
              before: previous,
            });
            previous = preset === "ask" ? previous : preset;
            expect(write.after).toBe(previous);
          }
          const scoped = await request({
            type: "extension_request",
            name: "cox.assets.scoped",
            data: {},
          });
          expect(scoped).toMatchObject(
            fixture.kind === "standalone"
              ? {
                  available: true,
                  identity: true,
                  blocked: true,
                  computedBlocked: true,
                  distinct: true,
                  sidecar: { marker: "transformed-fixture" },
                }
              : { available: false },
          );
          expect(stderr).not.toContain("Failed to load extension");
        } finally {
          child.kill("SIGTERM");
          await closed;
          lines.close();
          await NodeFS.rm(temporary, { recursive: true, force: true });
        }
      },
    );
  }
});
