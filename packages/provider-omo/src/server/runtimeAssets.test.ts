// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  OMO_RUNTIME_ASSET_COMPATIBILITY,
  OMO_RUNTIME_ASSETS_SOURCE,
  resolveOmoRuntimeAssets,
  type OmoRuntimeAssetPackage,
  type OmoRuntimeAssetSnapshot,
  type OmoRuntimeAssets,
} from "./runtimeAssets.ts";

const version = "5.1.69";
const engineVersion = "2026.11.10-2";
const manifestSha = "a".repeat(64);
const pluginManifest = { name: "@code-yeongyu/omo-senpi", version };
const standaloneRoot = "/isolated/.omo/binary-runtime/5.1.69";
const npmRoot = "/isolated/npm/node_modules/omo-ai";
const engineRoot = "/isolated/npm/node_modules/@code-yeongyu/senpi";
const embeddedManifest = { omoAiVersion: version, enginePin: engineVersion, manifestSha };

const npmPackage = (root = npmRoot, engine = engineRoot): OmoRuntimeAssetPackage => ({
  root,
  manifest: { name: "omo-ai", version, dependencies: { "@code-yeongyu/senpi": engineVersion } },
  pluginManifest,
  entryExists: true,
  taskExists: true,
  engine: {
    root: engine,
    manifest: { name: "@code-yeongyu/senpi", version: engineVersion },
    entryExists: true,
  },
});

const standalonePackage = (): OmoRuntimeAssetPackage => ({
  root: standaloneRoot,
  manifest: { name: "omo", version },
  pluginManifest,
  entryExists: true,
  taskExists: true,
  provisionedManifestSha: manifestSha,
});

const standalone = (): OmoRuntimeAssetSnapshot => ({
  executablePath: "/isolated/bin/omo",
  nativeRoot: standaloneRoot,
  sdkRoot: standaloneRoot,
  sdkVersion: version,
  compiled: true,
  embeddedManifest,
  packages: [standalonePackage()],
});

const npm = (): OmoRuntimeAssetSnapshot => ({
  executablePath: `${npmRoot}/bin/omo.js`,
  sdkRoot: engineRoot,
  sdkVersion: engineVersion,
  packages: [npmPackage()],
});

const resolve = (snapshot: OmoRuntimeAssetSnapshot) =>
  resolveOmoRuntimeAssets(snapshot, NodePath.posix);

describe("official OMO runtime asset selection", () => {
  it("resolves the standalone omo payload without an external Senpi package", () => {
    expect(resolve(standalone())).toEqual({
      kind: "standalone",
      packageRoot: standaloneRoot,
      pluginRoot: `${standaloneRoot}/plugin`,
      entryPath: `${standaloneRoot}/plugin/extensions/omo.js`,
      taskPath: `${standaloneRoot}/plugin/extensions/omo-task.js`,
      version,
      engineVersion,
      enginePackageRoot: standaloneRoot,
      engineRoot: null,
      permissions: {
        kind: "native-rpc",
        capability: "set_permission_preset_v1",
        fallbackPreset: "ask",
        parentBinding: "native-rpc",
        decisionModulePath: null,
      },
    });
  });

  it("keeps the managed npm layout and exact engine dependency", () => {
    expect(resolve(npm())).toMatchObject({
      kind: "npm",
      packageRoot: npmRoot,
      enginePackageRoot: engineRoot,
      engineRoot: `${engineRoot}/dist`,
      permissions: { kind: "native-rpc" },
    });
    expect(OMO_RUNTIME_ASSET_COMPATIBILITY).toEqual({
      version,
      engineVersion,
      permissionCapability: "set_permission_preset_v1",
    });
  });

  it("prefers the native standalone root over a stale configured npm root", () => {
    expect(
      resolve({
        ...standalone(),
        configuredRoot: npmRoot,
        packages: [npmPackage(), standalonePackage()],
      }).packageRoot,
    ).toBe(standaloneRoot);
  });

  it("prefers the selected npm launcher over unrelated nested node_modules", () => {
    expect(
      resolve({
        ...npm(),
        configuredRoot: "/workspace/node_modules/omo-ai",
        packages: [
          npmPackage(
            "/workspace/node_modules/omo-ai",
            "/workspace/node_modules/@code-yeongyu/senpi",
          ),
          standalonePackage(),
          npmPackage(),
        ],
      }).packageRoot,
    ).toBe(npmRoot);
  });

  it("locates npm assets after the official launcher execs the engine CLI", () => {
    expect(
      resolve({ ...npm(), executablePath: `${engineRoot}/dist/bundle/cli.js` }).packageRoot,
    ).toBe(npmRoot);
  });

  it("accepts an official npm runtime snapshot only for its recorded installation", () => {
    const snapshot = {
      ...npm(),
      sdkRoot: "/isolated/agent/runtime/build-id",
      sdkSnapshot: { buildId: "48fad659dbf98bcd", installPackageDir: engineRoot },
    };
    expect(resolve(snapshot).enginePackageRoot).toBe(engineRoot);
    expect(() =>
      resolve({ ...snapshot, sdkSnapshot: { buildId: "same", installPackageDir: "/other/senpi" } }),
    ).toThrow("different Senpi installation");
    expect(() =>
      resolve({ ...snapshot, sdkSnapshot: { buildId: "", installPackageDir: engineRoot } }),
    ).toThrow("different Senpi installation");
  });

  it("accepts a configured npm relocation only when it uses the running engine", () => {
    expect(
      resolve({
        ...npm(),
        executablePath: "/isolated/bin/omo-wrapper",
        configuredRoot: npmRoot,
      }).packageRoot,
    ).toBe(npmRoot);
    expect(() =>
      resolve({
        ...npm(),
        executablePath: "/isolated/bin/omo-wrapper",
        sdkRoot: "/unrelated/senpi",
        configuredRoot: npmRoot,
      }),
    ).toThrow("different Senpi installation");
  });

  it("does not treat prefix-sharing sibling directories as executable owners", () => {
    expect(() =>
      resolve({ executablePath: `${npmRoot}-stale/bin/omo.js`, packages: [npmPackage()] }),
    ).toThrow("belonging to the running");
  });

  it.each([
    { entryExists: false },
    { taskExists: false },
    { pluginManifest: undefined },
    { pluginManifest: { name: "omo-ai", version } },
    { pluginManifest: { ...pluginManifest, version: "5.1.68" } },
    { manifest: { name: "omo", version: "5.1.68" } },
  ])("rejects missing or mismatched standalone plugin assets: %j", (change) => {
    expect(() =>
      resolve({ ...standalone(), packages: [{ ...standalonePackage(), ...change }] }),
    ).toThrow();
  });

  it.each([
    undefined,
    {},
    { ...embeddedManifest, enginePin: "2026.11.09-1" },
    { ...embeddedManifest, omoAiVersion: "5.1.68" },
    { ...embeddedManifest, manifestSha: "b".repeat(64) },
    { ...embeddedManifest, manifestSha: "invalid" },
  ])("requires the current binary's matching provisioned manifest: %j", (manifest) => {
    expect(() => resolve({ ...standalone(), embeddedManifest: manifest })).toThrow(
      "embedded runtime manifest",
    );
  });

  it("does not fall back to a matching npm install when the standalone payload is missing", () => {
    expect(() => resolve({ ...standalone(), packages: [npmPackage()] })).toThrow(
      "standalone payload is unavailable",
    );
  });

  it("refuses a foreign native payload even when all versions match", () => {
    expect(() => resolve({ ...standalone(), nativeRoot: "/other/standalone" })).toThrow(
      "does not match the running native engine",
    );
    expect(() => resolve({ ...standalone(), sdkVersion: engineVersion })).toThrow(
      "SDK version does not match",
    );
  });

  it.each([
    undefined,
    {
      root: engineRoot,
      manifest: { name: "@code-yeongyu/senpi", version: "old" },
      entryExists: true,
    },
    { root: engineRoot, manifest: { name: "senpi", version: engineVersion }, entryExists: true },
    {
      root: engineRoot,
      manifest: { name: "@code-yeongyu/senpi", version: engineVersion },
      entryExists: false,
    },
  ])("rejects npm engines that are absent, mismatched or incomplete: %j", (engine) => {
    const candidate = npmPackage();
    const { engine: _engine, ...withoutEngine } = candidate;
    expect(() =>
      resolve({ ...npm(), packages: [{ ...withoutEngine, ...(engine ? { engine } : {}) }] }),
    ).toThrow("matching pinned Senpi engine");
  });

  it("fails instead of selecting another valid npm install after the chosen one is corrupt", () => {
    expect(() =>
      resolve({
        ...npm(),
        configuredRoot: "/other/omo-ai",
        packages: [npmPackage("/other/omo-ai"), { ...npmPackage(), taskExists: false }],
      }),
    ).toThrow("missing its official");
  });

  it("does not guess between packages sharing one engine without a launcher identity", () => {
    expect(() =>
      resolve({
        ...npm(),
        executablePath: `${engineRoot}/dist/cli.js`,
        packages: [npmPackage(), npmPackage("/other/omo-ai")],
      }),
    ).toThrow("More than one OMO package");
  });

  it("supports Windows official standalone paths without POSIX assumptions", () => {
    const root = "C:\\Users\\cox\\.omo\\binary-runtime\\5.1.69";
    const result = resolveOmoRuntimeAssets(
      {
        ...standalone(),
        executablePath: "C:\\Tools\\omo.exe",
        nativeRoot: root,
        sdkRoot: root,
        packages: [{ ...standalonePackage(), root }],
      },
      NodePath.win32,
    );
    expect(result.entryPath).toBe(`${root}\\plugin\\extensions\\omo.js`);
    expect(result.engineRoot).toBeNull();
  });

  it("rejects relative runtime identity paths", () => {
    expect(() => resolve({ ...npm(), executablePath: "omo" })).toThrow("absolute path");
    expect(() => resolve({ ...standalone(), configuredRoot: "relative" })).toThrow("absolute OMO");
  });
});

interface LoadedRuntimeAssets extends OmoRuntimeAssets {
  readonly entry: { readonly omoSenpiComponents: ReadonlyArray<{ readonly name: string }> };
  readonly tasks: { readonly createTaskComponent: () => unknown };
  readonly sdk: object;
  resolveModule(name: string): string;
  resolveImport(name: string): string | undefined;
  assertNativeSession(context: unknown): void;
}

interface LoaderModule {
  loadCoxOmoRuntimeAssets(options: {
    readonly env: NodeJS.ProcessEnv;
    readonly sdk: {
      readonly VERSION: string;
      readonly getPackageDir: () => string;
      readonly SessionManager: typeof SessionManager;
      readonly createAgentSession: () => void;
      readonly AgentSessionRuntime: typeof SessionManager;
    };
  }): Promise<LoadedRuntimeAssets>;
}

class SessionManager {
  getSessionId() {
    return "fixture-session";
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFS.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(
  options: { readonly invalidExports?: boolean; readonly brokenNearestEngine?: boolean } = {},
) {
  const directory = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cox-omo-assets-"));
  temporaryDirectories.push(directory);
  const root = NodePath.join(directory, "node_modules", "omo-ai");
  const engine = NodePath.join(directory, "node_modules", "@code-yeongyu", "senpi");
  await NodeFS.mkdir(NodePath.join(root, "plugin", "extensions"), { recursive: true });
  await NodeFS.mkdir(NodePath.join(root, "bin"), { recursive: true });
  await NodeFS.mkdir(NodePath.join(engine, "dist"), { recursive: true });
  await Promise.all([
    NodeFS.writeFile(NodePath.join(root, "package.json"), JSON.stringify(npmPackage().manifest)),
    NodeFS.writeFile(
      NodePath.join(root, "plugin", "package.json"),
      JSON.stringify({ ...pluginManifest, type: "module" }),
    ),
    NodeFS.writeFile(NodePath.join(root, "bin", "omo.js"), ""),
    NodeFS.writeFile(
      NodePath.join(root, "plugin", "extensions", "omo.js"),
      options.invalidExports
        ? "export default {};"
        : 'export const omoSenpiComponents = [{ name: "task" }]; export const composeOmoSenpiExtension = () => {};',
    ),
    NodeFS.writeFile(
      NodePath.join(root, "plugin", "extensions", "omo-task.js"),
      'export const createTaskComponent = () => ({ name: "task" });',
    ),
    NodeFS.writeFile(
      NodePath.join(root, "plugin", "extensions", "memory-run-supervisor.mjs"),
      "export {};",
    ),
    NodeFS.writeFile(
      NodePath.join(engine, "package.json"),
      JSON.stringify({ name: "@code-yeongyu/senpi", version: engineVersion }),
    ),
    NodeFS.writeFile(NodePath.join(engine, "dist", "index.js"), ""),
  ]);
  if (options.brokenNearestEngine) {
    const nearest = NodePath.join(root, "node_modules", "@code-yeongyu", "senpi");
    await NodeFS.mkdir(nearest, { recursive: true });
    await NodeFS.writeFile(
      NodePath.join(nearest, "package.json"),
      JSON.stringify({ name: "@code-yeongyu/senpi", version: "old" }),
    );
  }
  const sdk = {
    VERSION: engineVersion,
    getPackageDir: () => engine,
    SessionManager,
    createAgentSession: () => {},
    AgentSessionRuntime: SessionManager,
  };
  const module: LoaderModule = await import(
    `data:text/javascript;base64,${Buffer.from(`${OMO_RUNTIME_ASSETS_SOURCE}\nexport { loadCoxOmoRuntimeAssets };`).toString("base64")}`
  );
  return {
    root,
    engine,
    sdk,
    load: () =>
      module.loadCoxOmoRuntimeAssets({
        env: { OMO_BIN: NodePath.join(root, "bin", "omo.js"), COX_OMO_PACKAGE_ROOT: root },
        sdk,
      }),
  };
}

describe("generated native extension asset loader", () => {
  it("executes the same resolver and imports official plugin exports from the chosen package", async () => {
    const installed = await fixture();
    const loaded = await installed.load();
    expect(loaded.kind).toBe("npm");
    expect(loaded.packageRoot).toBe(installed.root);
    expect(loaded.enginePackageRoot).toBe(installed.engine);
    expect(loaded.sdk).toBe(installed.sdk);
    expect(loaded.entry.omoSenpiComponents).toEqual([{ name: "task" }]);
    expect(loaded.tasks.createTaskComponent()).toEqual({ name: "task" });
    expect(loaded.resolveModule("omo-task.js")).toBe(
      pathToFileURL(NodePath.join(installed.root, "plugin", "extensions", "omo-task.js")).href,
    );
    expect(loaded.resolveImport("@code-yeongyu/senpi")).toContain("/dist/index.js");
    expect(loaded.resolveImport("unknown-package")).toBeUndefined();
    expect(loaded.resolveModule("memory-run-supervisor.mjs")).toContain(
      "memory-run-supervisor.mjs",
    );
    expect(() =>
      loaded.assertNativeSession({ sessionManager: new SessionManager() }),
    ).not.toThrow();
    expect(() => loaded.assertNativeSession({ sessionManager: {} })).toThrow(
      "different native session registry",
    );
    expect(OMO_RUNTIME_ASSETS_SOURCE).not.toContain(
      'await import(pathToFileURL(join(engineRoot, "core", "permission-decision.js"))',
    );
    expect(OMO_RUNTIME_ASSETS_SOURCE).not.toContain("Bun.plugin(");
    expect(OMO_RUNTIME_ASSETS_SOURCE).not.toContain("registerHooks(");
  });

  it("rejects missing exported integration functions rather than accepting a default-only plugin", async () => {
    const installed = await fixture({ invalidExports: true });
    await expect(installed.load()).rejects.toThrow("required Cox integration exports");
  });

  it("does not skip an incompatible nearest Senpi to use a stale valid ancestor copy", async () => {
    const installed = await fixture({ brokenNearestEngine: true });
    await expect(installed.load()).rejects.toThrow("matching pinned Senpi engine");
  });

  it("restricts sibling plugin requests to present basenames in the selected installation", async () => {
    const loaded = await (await fixture()).load();
    for (const name of ["../omo.js", "/other/omo.js", "file:///other/omo.js", "omo-task.js?copy"]) {
      expect(() => loaded.resolveModule(name)).toThrow("asset basename");
    }
    expect(() => loaded.resolveModule("omo-missing.js")).toThrow("missing a plugin asset");
  });
});
