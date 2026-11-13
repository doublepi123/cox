import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { expect, it } from "vite-plus/test";
import { OMO_MEMORY_SOURCE } from "./memory.ts";

const fixtureSource = String.raw`
import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
import { createCoxOmoMemoryComponent } from "./memory-source.mjs";

const [root, temporary, configFile] = process.argv.slice(2);
const home = join(temporary, "home");
const agent = join(temporary, "agent");
const memory = join(temporary, "memory");
const project = join(temporary, "project-a");
const secondProject = join(temporary, "project-b");
for (const directory of [home, agent, project, secondProject]) await mkdir(directory, { recursive: true });
Object.assign(process.env, {
  HOME: home, USERPROFILE: home, OMO_MEMORY_HOME: memory,
  OMO_CODING_AGENT_DIR: agent, SENPI_CODING_AGENT_DIR: agent, PI_CODING_AGENT_DIR: agent,
  COX_OMO_MEMORY_HOME: memory, COX_OMO_MANAGED_MODELS: "1", COX_OMO_ALLOWED_MODELS: '["cox/main","cox/expert"]',
  COX_MODEL_SERVICE_KEY: "fixture-only-not-a-live-key",
  COX_OMO_GATEWAY_TIMEOUT_MS: "630000",
  CI: "1", GIT_CONFIG_GLOBAL: join(temporary, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
});
await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { cox: {
  baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "$COX_MODEL_SERVICE_KEY",
  headers: { Authorization: "forbidden-inline-secret" },
  models: ["main", "expert"].map(id => ({ id, name: id, contextWindow: 100000, maxTokens: 4096,
    headers: { Authorization: "forbidden-model-secret" } })),
}, anthropic: { apiKey: "forbidden-other-secret", models: [] } } }));
await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { modelFallback: true, fallbackChains: { "*": ["anthropic/outside"] } } }));
await mkdir(join(home, ".omo"), { recursive: true });
const hostileConfig = JSON.stringify({ memory: { enabled: false, agent: "outside", sync: { enabled: true } },
  categories: { quick: { models: ["anthropic/outside"] } } });
await writeFile(join(home, ".omo", "omo.json"), hostileConfig);
await mkdir(join(project, ".omo"), { recursive: true });
await writeFile(join(project, ".omo", "omo.json"), hostileConfig);

let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error("No model or cloud network is allowed in the native memory fixture."); };
const engine = join(root, "..", "@code-yeongyu", "senpi", "dist", "core");
const { SessionLifecycleController } = await import(pathToFileURL(join(engine, "session-lifecycle.js")).href);
const { createLifecycleApi } = await import(pathToFileURL(join(engine, "extensions", "lifecycle-api.js")).href);
for (const endedBy of ["provider-stop", "provider-error"]) {
  const entries = [];
  const sessionId = "memory-restart-" + endedBy;
  const controllerOptions = {
    sessionId, entries,
    append: data => entries.push({ type: "custom", customType: "session-lifecycle", data }),
    appendCustody: data => entries.push({ type: "custom", customType: "work-custody", data: { ...data, sessionId } }),
    appendChild() {}, emit() {},
    readRuntime: () => ({ activity: { isStreaming: false, isCompacting: false, isBashRunning: false, hasSessionWork: false },
      pendingMessages: 0, holds: [], human: [], inputAdmissionPending: false }),
  };
  const before = new SessionLifecycleController(controllerOptions);
  before.restoreComplete();
  before.startRun("human");
  before.obligations.open("cox-memory:114328:125", "background", "Local automatic memory");
  before.obligations.open("cox-memory:114328:127", "background", "Local automatic memory");
  const end = { endedBy, budgetSpent: false, deadlineStop: false, isChildSession: false, mode: "rpc",
    willRetry: false, goalStopped: false, openWork: { kind: "none" }, expectations: [] };
  before.goalFacts(null, end);
  before.idle();
  assert.equal(before.ledger.snapshot.state, "waiting_background");
  const restored = new SessionLifecycleController(controllerOptions);
  restored.obligations.retireRestoredSources();
  restored.restoreComplete();
  assert.equal(restored.ledger.snapshot.state, "waiting_background");
  const handlers = new Map();
  const recoveredMemory = await createCoxOmoMemoryComponent({ root, config: {}, env: process.env,
    native: { parseMemorySettings: value => value, createMemoryComponent: () => ({ register() {} }) },
  });
  await recoveredMemory.register({ lifecycle: createLifecycleApi(() => restored),
    on: (name, handler) => handlers.set(name, handler) }, {});
  await handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } });
  assert.equal(restored.obligations.activeCount, 0, "Restart must retire process-local Cox memory custody");
  assert.equal(restored.ledger.snapshot.state, endedBy === "provider-error" ? "failed" : "done");
  assert.equal(typeof restored.ledger.snapshot.completionId, "string");
  assert.equal(restored.ledger.snapshot.persisted, true);
  recoveredMemory.dispose();
}
const { ModelRegistry } = await import(pathToFileURL(join(engine, "model-registry.js")).href);
const { AuthStorage } = await import(pathToFileURL(join(engine, "auth-storage.js")).href);
const registry = ModelRegistry.create(AuthStorage.inMemory(), join(agent, "models.json"));
const main = registry.find("cox", "main");
assert.ok(main);
let factsResolve;
const factsCommitted = new Promise(resolve => { factsResolve = resolve; });
const starts = [];
const reflectionProbe = join(temporary, "reflection-probe.json");
const reflectionScript = join(temporary, "reflection-child.mjs");
await writeFile(reflectionScript, [
  'import {writeFileSync} from "node:fs";',
  'import {execFileSync} from "node:child_process";',
  'writeFileSync(' + JSON.stringify(reflectionProbe) + ', JSON.stringify({args:process.argv.slice(2),agentDir:process.env.SENPI_CODING_AGENT_DIR,' +
    'keyPresent:process.env.COX_MODEL_SERVICE_KEY==="fixture-only-not-a-live-key",apiKey:process.env.OPENAI_API_KEY,root:process.env.OMO_MEMORY_HOME}));',
  'writeFileSync(process.env.MEMORY_DIR+"/system/reflected.md","---\\ndescription: Reflected fixture\\n---\\nReflection fixture was local.\\n");',
  'execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@cox.local","add","system/reflected.md"],{cwd:process.env.MEMORY_DIR});',
  'execFileSync("git",["-c","user.name=Fixture","-c","user.email=fixture@cox.local","commit","-m","Fixture reflection commit"],{cwd:process.env.MEMORY_DIR});',
].join("\n"));
const component = await createCoxOmoMemoryComponent({ root,
  config: JSON.parse(await readFile(configFile, "utf8")), env: process.env,
  reflectionOptions: {
    senpiCommand: process.execPath, senpiPrefixArgs: [reflectionScript],
    resolveAndPreflightLaunch: async options => options.attempt(options.candidates[0], 1),
  },
  factsOptions: {
    createRunner: () => ({ start: async spec => {
      starts.push({ model: spec.model, selectedModel: spec.selectedModel, fallbackModels: spec.fallbackModels, agentDir: spec.agentDir });
      assert.equal(spec.selectedModel, "cox/main");
      assert.equal(spec.model.provider, "cox");
      assert.equal(spec.model.id, "main");
      assert.equal(spec.fallbackModels?.length ?? 0, 0);
      assert.ok(spec.agentDir.startsWith(memory));
      const fact = spec.memberScopedTools.find(tool => tool.name === "record_fact");
      assert.ok(fact);
      const result = await fact.execute("fixture-fact", { scope: "person", person: { name: "human", aliases: [] },
        text: "Prefers reproducible fixture testing.", date: "2026-11-12", source: "agent" });
      assert.equal(result.isError, undefined);
      return { waitForIdle: async () => ({ status: "completed" }), dispose() {}, async abort() {} };
    } }),
    writeTerminalSentinel: async (path, value) => {
      await writeFile(path, JSON.stringify(value));
      if (value.outcome === "committed") factsResolve(value);
    },
  },
});
const warnings = [];
const logger = { info() {}, warn: (message, data) => warnings.push({ message, data }), error: (message, data) => warnings.push({ message, data }) };
function session(cwd, id) {
  const hooks = new Map();
  const tools = new Map();
  const commands = new Map();
  const rpcs = new Map();
  const entries = [];
  const ctx = { cwd, hasUI: false, model: main, modelRegistry: registry, isIdle: () => true,
    sessionManager: { getSessionId: () => id, getEntries: () => entries, getBranch: () => entries,
      getEntryCount: () => entries.length, getSessionFile: () => join(agent, id + ".jsonl") },
    getContextUsage: () => ({ tokens: 0, contextWindow: 100000 }) };
  const pi = { cwd,
    lifecycle: { obligations: { open: () => ({ close() {} }) } },
    on(name, handler, options) { const list = hooks.get(name) ?? []; list.push({ handler, options }); hooks.set(name, list); },
    registerTool: tool => tools.set(tool.name, tool), registerCommand: (name, command) => commands.set(name, command),
    appendEntry: (customType, data) => entries.push({ id: "custom-" + entries.length, type: "custom", customType, data }),
    registerEntryRenderer() {}, registerMessageRenderer() {}, getFlag: () => false, registerFlag() {}, sendMessage() {}, sendUserMessage() {},
    events: { on: () => () => {}, emit() {} }, rpc: { handle: (name, handler) => rpcs.set(name, handler), emit() {} },
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()],
  };
  return { pi, ctx, tools, commands, rpcs, entries,
    async dispatch(name, event = {}) { const results = []; for (const { handler } of hooks.get(name) ?? []) results.push(await handler(event, ctx)); return results; },
  };
}
const context = { logger, config: { getFlag: () => false }, getCapturedTools: () => [] };
const first = session(project, "first-session");
await component.register(first.pi, context);
assert.ok(first.tools.has("memory"));
assert.ok(!first.commands.has("memory-repository"));
assert.ok(![...first.rpcs.keys()].some(name => name.startsWith("omo.memory.sync")));
await first.dispatch("session_start");
await first.dispatch("before_agent_start", { type: "before_agent_start", prompt: "Remember fixture preference", systemPrompt: "Fixture system" });
assert.equal(component.loadConfig().config.memory.enabled, true);
assert.equal(component.loadConfig().config.memory.sync.enabled, false);
assert.equal(component.loadConfig().config.memory.facts.model, "cox/main");
const firstBinding = first.entries.find(entry => entry.customType === "senpi-memory.session-binding").data;
const repo = join(memory, "agents", firstBinding.identity, "repo");
const write = await first.tools.get("memory").execute("fixture-write", { command: "create", file_path: "system/fixture.md",
  description: "Fixture preference", file_text: "Prefer reproducible fixture testing.", source: "agent", reason: "Fixture local memory write" });
assert.equal(write.isError, undefined);
assert.match(await readFile(join(repo, "system", "fixture.md"), "utf8"), /Prefer reproducible fixture testing/);
assert.equal(await readFile(join(repo, ".git", "hooks", "post-commit"), "utf8"), "#!/bin/sh\nexit 0\n".replaceAll("\\n", "\n"));
assert.ok(!String(await readFile(join(repo, ".git", "hooks", "pre-commit"), "utf8")).includes("git push"));
execFileSync("git", ["config", "--local", "omo.memoryRepository.url", join(temporary, "must-not-push")], { cwd: repo });
const secondWrite = await first.tools.get("memory").execute("fixture-second-write", { command: "create", file_path: "system/second.md",
  description: "Second fixture", file_text: "No remote synchronization.", source: "agent", reason: "Fixture local no-push write" });
assert.equal(secondWrite.isError, undefined);
assert.equal(await stat(join(repo, ".git", "memory-repository-push.log")).catch(() => undefined), undefined);

await first.dispatch("input", { source: "rpc", inputId: "fixture-input", text: "Prefer reproducible fixture testing." });
await first.dispatch("input_disposition", { inputId: "fixture-input", disposition: "started" });
for (let index = 0; index < 4; index++) {
  first.entries.push({ id: "user-" + index, type: "message", message: { role: "user", content: "Prefer reproducible fixture testing." } },
    { id: "assistant-" + index, type: "message", message: { role: "assistant", content: [{ type: "text", text: "I will use reproducible fixture testing." }], stopReason: "stop" } });
  await first.dispatch("agent_end", { aborted: false });
  await first.dispatch("agent_settled", { type: "agent_settled" });
}
const factsTimeout = setTimeout(() => { console.error(JSON.stringify({ starts, warnings })); throw new Error("Native automatic facts did not commit."); }, 15000);
const final = await factsCommitted;
clearTimeout(factsTimeout);
assert.equal(final.outcome, "committed");
assert.equal(starts.length, 1);
assert.match(await readFile(join(repo, "people", "human", "observations.md"), "utf8"), /Prefers reproducible fixture testing/);
await first.commands.get("reflect").handler("", first.ctx);
await component.whenIdle();
const reflection = JSON.parse(await readFile(reflectionProbe, "utf8"));
assert.equal(reflection.keyPresent, true);
assert.equal(reflection.apiKey, undefined);
assert.equal(reflection.root, memory);
assert.equal(reflection.args[reflection.args.indexOf("--model") + 1], "cox/main");
assert.ok(reflection.agentDir.startsWith(memory));
assert.match(await readFile(join(repo, "system", "reflected.md"), "utf8"), /Reflection fixture was local/);
const artifacts = await readdir(join(memory, "agents", firstBinding.identity, "runtime"), { recursive: true });
const manifests = artifacts.filter(name => name.endsWith("launch.json"));
assert.ok(manifests.length > 0);
for (const name of manifests) assert.ok(!(await readFile(join(memory, "agents", firstBinding.identity, "runtime", name), "utf8")).includes("fixture-only-not-a-live-key"));
await first.dispatch("session_shutdown", { reason: "quit" });
const second = session(secondProject, "second-session");
await component.register(second.pi, context);
await second.dispatch("session_start");
const projected = await second.dispatch("before_agent_start", { type: "before_agent_start", prompt: "Recall preference", systemPrompt: "Fixture system" });
const secondBinding = second.entries.find(entry => entry.customType === "senpi-memory.session-binding").data;
assert.equal(firstBinding.identity, secondBinding.identity);
assert.equal(firstBinding.repoPathHash, secondBinding.repoPathHash);
assert.ok(projected.some(value => value?.systemPrompt?.includes("Prefer reproducible fixture testing.")));
await second.dispatch("session_shutdown", { reason: "quit" });
const privateDir = join(memory, "runtime", "cox");
const { createAgentSession } = await import(pathToFileURL(join(engine, "sdk.js")).href);
const { SessionManager } = await import(pathToFileURL(join(engine, "session-manager.js")).href);
const { SettingsManager } = await import(pathToFileURL(join(engine, "settings-manager.js")).href);
const { DefaultResourceLoader } = await import(pathToFileURL(join(engine, "resource-loader.js")).href);
const settingsManager = SettingsManager.create(project, privateDir);
const resourceLoader = new DefaultResourceLoader({ cwd: project, agentDir: privateDir, settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
await resourceLoader.reload();
const { session: childSession } = await createAgentSession({ cwd: project, agentDir: privateDir,
  sessionManager: SessionManager.inMemory(project), settingsManager, resourceLoader,
  modelRegistry: component.scopeModelRegistry(registry), model: main, tools: [] });
assert.equal(childSession.model.provider, "cox");
assert.equal(childSession.agent.streamStartTimeoutMs, 630000);
assert.equal(childSession.agent.streamKeepAliveTimeoutMs, 630000);
childSession.dispose();
const privateCatalog = await readFile(join(privateDir, "models.json"), "utf8");
assert.ok(!privateCatalog.includes("forbidden"));
assert.deepEqual(Object.keys(JSON.parse(privateCatalog).providers), ["cox"]);
assert.deepEqual(JSON.parse(await readFile(join(privateDir, "settings.json"), "utf8")).retry, { enabled: false, modelFallback: false, fallbackChains: {}, provider: { timeoutMs: 630000, streamStartTimeoutMs: 630000, keepAliveTimeoutMs: 630000 } });
const managedSettings = SettingsManager.create(privateDir, privateDir);
assert.equal(managedSettings.getAgentStreamStartTimeoutMs(), 630000);
assert.equal(managedSettings.getAgentStreamIdleTimeoutMs(), 630000);
assert.equal(managedSettings.getHttpIdleTimeoutMs(), 630000);
assert.equal((await stat(join(privateDir, "auth.json"))).mode & 0o777, 0o600);
assert.equal((await stat(privateDir)).mode & 0o777, 0o700);
assert.equal(await readFile(join(home, ".omo", "omo.json"), "utf8"), hostileConfig);
assert.equal(await stat(join(home, ".omo", "memory")).catch(() => undefined), undefined);
assert.equal(await stat(join(memory, "transient-runs")).catch(() => undefined), undefined);
assert.equal(networkCalls, 0);
assert.ok(warnings.every(warning => warning.message === "memory reflection sandbox degraded"));
component.dispose();

const taskUrl = pathToFileURL(join(root, "plugin", "extensions", "omo-task.js")).href;
const taskSource = await readFile(new URL(taskUrl), "utf8");
assert.equal(createHash("sha256").update(taskSource).digest("hex"), "ae1f9b564c8ce70033620bfd9b08c19ba3f8ac825fa3ebc6b4a2efd5f5622250");
const scopeUrl = taskUrl + "?cox-native-category-test";
const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === scopeUrl ? { url: scopeUrl, shortCircuit: true } : next(specifier, context); },
  load(url, context, next) { return url === scopeUrl ? { format: "module", source: taskSource + "\nexport {uk as resolveCategory};", shortCircuit: true } : next(url, context); } });
try {
  const native = await import(scopeUrl);
  const config = JSON.parse(await readFile(configFile, "utf8"));
  for (const category of ["deep", "deep-low", "deep-high"]) {
    const resolved = native.resolveCategory(category, config, registry);
    assert.equal(resolved.kind, "resolved");
    assert.equal(resolved.spec.provider, "cox");
    assert.equal(resolved.spec.modelId, category === "deep-high" ? "main" : "expert");
    assert.equal(resolved.spec.fallback_models?.length ?? 0, 0);
  }
} finally { hooks.deregister(); }
console.log(JSON.stringify({ registration: true, persisted: true, automaticFacts: final.outcome, reflection: true,
  crossProjectRecall: true, isolatedCatalog: true, noRemotePush: true, networkCalls, deepRouting: true }));
`;

it.skipIf(!process.env.COX_OMO_NATIVE_TEST_ROOT)(
  "runs the pinned native memory pipeline and native deep routing without live state, credentials or model calls",
  () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const root = process.env.COX_OMO_NATIVE_TEST_ROOT!;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "cox-memory-native-test-" });
        yield* fs.writeFileString(
          path.join(temporary, "memory-source.mjs"),
          `${OMO_MEMORY_SOURCE}\nexport {createCoxOmoMemoryComponent};`,
        );
        yield* fs.writeFileString(path.join(temporary, "fixture.mjs"), fixtureSource);
        const configFile = path.join(temporary, "config.json");
        yield* fs.writeFileString(
          configFile,
          JSON.stringify({
            agents: {},
            teams: {},
            task: {},
            categories: {
              deep: { models: ["cox/expert"], models_distribution: "round_robin" },
              "deep-low": { models: ["cox/expert"], models_distribution: "round_robin" },
              "deep-high": { models: ["cox/main"], models_distribution: "round_robin" },
            },
          }),
        );
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) =>
              !/(?:KEY|TOKEN|PASSWORD|SECRET|^OMO_|^SENPI_|^PI_|^NODE_OPTIONS$)/i.test(key),
          ),
        );
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            process.execPath,
            [path.join(temporary, "fixture.mjs"), root, temporary, configFile],
            { env: environment },
          ),
        );
        const output = yield* Effect.all(
          {
            stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
            stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
            code: handle.exitCode,
          },
          { concurrency: "unbounded" },
        );
        expect(output.code, output.stderr).toBe(0);
        const report = JSON.parse(output.stdout.trim().split("\n").at(-1)!);
        expect(report).toEqual({
          registration: true,
          persisted: true,
          automaticFacts: "committed",
          reflection: true,
          crossProjectRecall: true,
          isolatedCatalog: true,
          noRemotePush: true,
          networkCalls: 0,
          deepRouting: true,
        });
        if (process.env.COX_OMO_MEMORY_TEST_REPORT)
          yield* fs.writeFileString(
            process.env.COX_OMO_MEMORY_TEST_REPORT,
            JSON.stringify(report, null, 2),
          );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.timeout("45 seconds")),
    ),
);
