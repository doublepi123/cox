export interface OmoRuntimeAssetPath {
  readonly sep: string;
  join(...paths: ReadonlyArray<string>): string;
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
}

export interface OmoRuntimeAssetPackage {
  readonly root: string;
  readonly manifest: unknown;
  readonly pluginManifest: unknown;
  readonly entryExists: boolean;
  readonly taskExists: boolean;
  readonly engine?: {
    readonly root: string;
    readonly manifest: unknown;
    readonly entryExists: boolean;
  };
  readonly provisionedManifestSha?: string;
}

export interface OmoRuntimeAssetSnapshot {
  readonly executablePath: string;
  readonly configuredRoot?: string;
  readonly nativeRoot?: string;
  readonly sdkRoot?: string;
  readonly sdkSnapshot?: unknown;
  readonly sdkVersion?: string;
  readonly compiled?: boolean;
  readonly embeddedManifest?: unknown;
  readonly packages: ReadonlyArray<OmoRuntimeAssetPackage>;
}

export interface OmoRuntimeAssets {
  readonly kind: "npm" | "standalone";
  readonly packageRoot: string;
  readonly pluginRoot: string;
  readonly entryPath: string;
  readonly taskPath: string;
  readonly version: string;
  readonly engineVersion: string;
  readonly enginePackageRoot: string;
  readonly engineRoot: string | null;
  readonly permissions: {
    readonly kind: "native-rpc";
    readonly capability: "set_permission_preset_v1";
    readonly fallbackPreset: "ask";
    readonly parentBinding: "native-rpc" | "installed-engine";
    readonly decisionModulePath: string | null;
  };
}

export interface OmoScopedRuntimeModules {
  readonly entryUrl: string;
  readonly modules: ReadonlyMap<string, { readonly name: string; readonly source: string }>;
  readonly aliases: Readonly<Record<string, string>>;
  readonly blockedImports: ReadonlyArray<string>;
}

function createOmoRuntimeAssetResolver(path: OmoRuntimeAssetPath) {
  const version = "5.1.69";
  const engineVersion = "2026.11.10-2";
  const record = (value: unknown): Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const same = (left: string, right: string) => path.relative(left, right) === "";
  const contains = (root: string, file: string) => {
    const relative = path.relative(root, file);
    return (
      relative === "" ||
      (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
    );
  };

  return {
    version,
    engineVersion,
    resolve(snapshot: OmoRuntimeAssetSnapshot): OmoRuntimeAssets {
      if (!path.isAbsolute(snapshot.executablePath))
        throw new Error("Cox requires an absolute path for the running OMO executable.");
      for (const root of [
        snapshot.configuredRoot,
        snapshot.nativeRoot,
        snapshot.sdkRoot,
        ...snapshot.packages.map((candidate) => candidate.root),
      ]) {
        if (root !== undefined && !path.isAbsolute(root))
          throw new Error("Cox requires absolute OMO runtime package roots.");
      }
      const find = (root: string | undefined) =>
        root === undefined
          ? undefined
          : snapshot.packages.find((candidate) => same(candidate.root, root));
      let selected: OmoRuntimeAssetPackage | undefined;
      if (snapshot.compiled) {
        if (
          snapshot.nativeRoot !== undefined &&
          snapshot.sdkRoot !== undefined &&
          !same(snapshot.nativeRoot, snapshot.sdkRoot)
        )
          throw new Error("The OMO standalone payload does not match the running native engine.");
        selected = find(snapshot.sdkRoot ?? snapshot.nativeRoot);
        if (record(selected?.manifest).name !== "omo")
          throw new Error("The official OMO standalone payload is unavailable.");
      } else {
        const owners = snapshot.packages.filter(
          (candidate) =>
            ["omo-ai", "omo"].includes(String(record(candidate.manifest).name)) &&
            contains(candidate.root, snapshot.executablePath),
        );
        selected = owners.sort((left, right) => right.root.length - left.root.length)[0];
        if (selected === undefined && snapshot.sdkRoot !== undefined) {
          const marker = record(snapshot.sdkSnapshot);
          const installRoot =
            typeof marker.buildId === "string" &&
            marker.buildId.length > 0 &&
            typeof marker.installPackageDir === "string" &&
            path.isAbsolute(marker.installPackageDir)
              ? marker.installPackageDir
              : snapshot.sdkRoot;
          const matches = snapshot.packages.filter(
            (candidate) =>
              record(candidate.manifest).name === "omo-ai" &&
              candidate.engine !== undefined &&
              same(candidate.engine.root, installRoot),
          );
          if (matches.length > 1)
            throw new Error(
              "More than one OMO package uses the running engine; specify its launcher.",
            );
          selected = matches[0];
        }
        selected ??= find(snapshot.configuredRoot);
      }
      if (selected === undefined)
        throw new Error(
          "Cox could not locate assets belonging to the running official OMO installation.",
        );
      const manifest = record(selected.manifest);
      const plugin = record(selected.pluginManifest);
      if (!["omo-ai", "omo"].includes(String(manifest.name)) || manifest.version !== version)
        throw new Error(`Cox requires official OMO ${version} runtime assets.`);
      if (plugin.name !== "@code-yeongyu/omo-senpi" || plugin.version !== manifest.version)
        throw new Error("The OMO plugin identity or version does not match its runtime.");
      if (!selected.entryExists || !selected.taskExists)
        throw new Error(
          "The OMO runtime is missing its official omo.js or omo-task.js plugin asset.",
        );
      const standalone = manifest.name === "omo";
      if (standalone) {
        const embedded = record(snapshot.embeddedManifest);
        if (
          snapshot.compiled !== true ||
          embedded.omoAiVersion !== version ||
          embedded.enginePin !== engineVersion ||
          typeof embedded.manifestSha !== "string" ||
          !/^[a-f0-9]{64}$/.test(embedded.manifestSha) ||
          selected.provisionedManifestSha !== embedded.manifestSha
        )
          throw new Error(
            "The OMO standalone assets do not match this executable's embedded runtime manifest.",
          );
      } else {
        const dependency = record(manifest.dependencies)["@code-yeongyu/senpi"];
        const engine = record(selected.engine?.manifest);
        if (
          dependency !== engineVersion ||
          engine.name !== "@code-yeongyu/senpi" ||
          engine.version !== dependency ||
          !selected.engine?.entryExists
        )
          throw new Error("The OMO npm installation is missing its matching pinned Senpi engine.");
        if (snapshot.compiled)
          throw new Error("A standalone OMO process cannot use an unrelated npm engine.");
      }
      const enginePackageRoot = standalone ? selected.root : selected.engine!.root;
      if (snapshot.sdkRoot !== undefined && !same(snapshot.sdkRoot, enginePackageRoot)) {
        const marker = record(snapshot.sdkSnapshot);
        if (
          standalone ||
          typeof marker.buildId !== "string" ||
          marker.buildId.length === 0 ||
          typeof marker.installPackageDir !== "string" ||
          !path.isAbsolute(marker.installPackageDir) ||
          !same(marker.installPackageDir, enginePackageRoot)
        )
          throw new Error(
            "The OMO assets resolve to a different Senpi installation than the running engine.",
          );
      }
      if (
        snapshot.sdkVersion !== undefined &&
        snapshot.sdkVersion !== (standalone ? version : engineVersion)
      )
        throw new Error("The running OMO SDK version does not match the selected runtime assets.");
      const pluginRoot = path.join(selected.root, "plugin");
      return {
        kind: standalone ? "standalone" : "npm",
        packageRoot: selected.root,
        pluginRoot,
        entryPath: path.join(pluginRoot, "extensions", "omo.js"),
        taskPath: path.join(pluginRoot, "extensions", "omo-task.js"),
        version,
        engineVersion,
        enginePackageRoot,
        engineRoot: standalone ? null : path.join(enginePackageRoot, "dist"),
        permissions: {
          kind: "native-rpc",
          capability: "set_permission_preset_v1",
          fallbackPreset: "ask",
          parentBinding: standalone ? "native-rpc" : "installed-engine",
          decisionModulePath: standalone
            ? null
            : path.join(enginePackageRoot, "dist", "core", "permission-decision.js"),
        },
      };
    },
  };
}

export function resolveOmoRuntimeAssets(
  snapshot: OmoRuntimeAssetSnapshot,
  path: OmoRuntimeAssetPath,
): OmoRuntimeAssets {
  return createOmoRuntimeAssetResolver(path).resolve(snapshot);
}

export const OMO_RUNTIME_ASSET_COMPATIBILITY = {
  version: "5.1.69",
  engineVersion: "2026.11.10-2",
  permissionCapability: "set_permission_preset_v1",
} as const;

export const OMO_RUNTIME_ASSETS_SOURCE = `
const coxOmoRuntimeAssetResolver = (${createOmoRuntimeAssetResolver.toString()})(await import("node:path"));
${String.raw`
async function loadCoxOmoRuntimeAssets(options = {}) {
  const path = await import("node:path");
  const { readFileSync, realpathSync, statSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const environment = options.env ?? process.env;
  const sdk = options.sdk ?? await import("@code-yeongyu/senpi");
  if (typeof sdk.getPackageDir !== "function" || typeof sdk.SessionManager !== "function" ||
      typeof sdk.createAgentSession !== "function" || typeof sdk.AgentSessionRuntime !== "function")
    throw new Error("The running OMO engine does not expose the required native SDK interfaces.");
  const canonical = value => {
    if (!path.isAbsolute(value)) throw new Error("Cox requires an absolute OMO runtime path.");
    try { return realpathSync(value); } catch { return path.resolve(value); }
  };
  const exists = value => {
    try { return statSync(value).isFile(); } catch { return false; }
  };
  const readText = value => {
    try {
      if (statSync(value).size > 1024 * 1024) return undefined;
      return readFileSync(value, "utf8");
    } catch { return undefined; }
  };
  const readJson = value => {
    try { return JSON.parse(readText(value) ?? "null"); } catch { return undefined; }
  };
  const sdkRoot = canonical(sdk.getPackageDir());
  const nativeRoot = environment.OMO_PACKAGE_DIR || environment.SENPI_PACKAGE_DIR;
  const configuredRoot = environment.COX_OMO_PACKAGE_ROOT;
  const executablePath = canonical(environment.OMO_BIN || process.argv[1] || process.execPath);
  const roots = new Set();
  const add = value => { if (value) roots.add(canonical(value)); };
  add(sdkRoot);
  add(nativeRoot);
  const embeddedFiles = globalThis.Bun?.embeddedFiles;
  const compiled = Array.isArray(embeddedFiles) && embeddedFiles.length > 0;
  if (!compiled) {
    add(configuredRoot);
    const snapshot = readJson(path.join(sdkRoot, "runtime-snapshot.json"));
    const installRoot = typeof snapshot?.installPackageDir === "string" ? snapshot.installPackageDir : undefined;
    for (const start of [executablePath, sdkRoot, ...(installRoot ? [canonical(installRoot)] : [])]) {
      let directory = path.dirname(start);
      for (let index = 0; index < 12; index++) {
        add(directory);
        add(path.join(directory, "node_modules", "omo-ai"));
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
  }
  let embeddedManifest;
  if (compiled) {
    for (const file of embeddedFiles) {
      if (!/(^|\/)runtime-manifest\.json$/.test(file.name)) continue;
      if (typeof file.size === "number" && file.size > 4 * 1024 * 1024)
        throw new Error("The OMO embedded runtime manifest exceeds the asset limit.");
      const text = typeof file.text === "function" ? await file.text() :
        typeof file.arrayBuffer === "function" ? Buffer.from(await file.arrayBuffer()).toString("utf8") : undefined;
      try {
        const parsed = JSON.parse(text ?? "null");
        if (typeof parsed?.omoAiVersion === "string" && typeof parsed?.enginePin === "string") {
          embeddedManifest = parsed;
          break;
        }
      } catch {}
    }
  }
  const packages = [...roots].flatMap(root => {
    const manifest = readJson(path.join(root, "package.json"));
    if (manifest?.name !== "omo" && manifest?.name !== "omo-ai") return [];
    let engine;
    if (manifest.name === "omo-ai") {
      const directories = createRequire(path.join(root, "package.json")).resolve.paths("@code-yeongyu/senpi") ?? [];
      for (const directory of directories) {
        const candidate = path.join(directory, "@code-yeongyu", "senpi");
        const engineManifest = readJson(path.join(candidate, "package.json"));
        if (engineManifest === undefined || engineManifest === null) continue;
        const engineRoot = canonical(candidate);
        engine = { root: engineRoot, manifest: engineManifest, entryExists: exists(path.join(engineRoot, "dist", "index.js")) };
        break;
      }
    }
    return [{ root, manifest, engine,
      pluginManifest: readJson(path.join(root, "plugin", "package.json")),
      entryExists: exists(path.join(root, "plugin", "extensions", "omo.js")),
      taskExists: exists(path.join(root, "plugin", "extensions", "omo-task.js")),
      provisionedManifestSha: readText(path.join(root, ".provisioned"))?.trim(),
    }];
  });
  const assets = coxOmoRuntimeAssetResolver.resolve({
    executablePath,
    configuredRoot: configuredRoot && !compiled ? canonical(configuredRoot) : undefined,
    nativeRoot: nativeRoot ? canonical(nativeRoot) : undefined,
    sdkRoot, sdkSnapshot: readJson(path.join(sdkRoot, "runtime-snapshot.json")),
    sdkVersion: sdk.VERSION, compiled, embeddedManifest, packages,
  });
  const entry = await import(pathToFileURL(assets.entryPath).href);
  const tasks = await import(pathToFileURL(assets.taskPath).href);
  if (typeof entry.composeOmoSenpiExtension !== "function" || !Array.isArray(entry.omoSenpiComponents) ||
      typeof tasks.createTaskComponent !== "function")
    throw new Error("The official OMO plugin does not expose the required Cox integration exports.");
  const resolveModule = name => {
    if (typeof name !== "string" || !/^[a-z0-9][a-z0-9-]*\.m?js$/.test(name))
      throw new Error("Cox requires an OMO plugin asset basename.");
    const filename = path.join(assets.pluginRoot, "extensions", name);
    if (!exists(filename)) throw new Error("The selected OMO installation is missing a plugin asset.");
    return pathToFileURL(filename).href;
  };
  const virtualModules = new Set([
    "@code-yeongyu/senpi", "@code-yeongyu/senpi/session-worker-data",
    ...["@earendil-works", "@mariozechner"].flatMap(scope => [
      "pi-coding-agent", "pi-agent-core", "pi-tui", "pi-ai", "pi-ai/compat", "pi-ai/oauth", "pi-ai/providers/all",
    ].map(name => scope + "/" + name)),
    "typebox", "typebox/compile", "typebox/value", "@sinclair/typebox", "@sinclair/typebox/compile", "@sinclair/typebox/value",
  ]);
  const resolveImport = name => {
    if (virtualModules.has(name) && compiled) return name;
    if (name.startsWith("node:")) return name;
    if (name === "@code-yeongyu/senpi" || name === "@earendil-works/pi-coding-agent" || name === "@mariozechner/pi-coding-agent")
      return pathToFileURL(path.join(assets.engineRoot, "index.js")).href;
    if (name === "@code-yeongyu/senpi/session-worker-data")
      return pathToFileURL(path.join(assets.engineRoot, "modes", "rpc", "session-worker-data.js")).href;
    return undefined;
  };
  const assertNativeSession = context => {
    if (!(context?.sessionManager instanceof sdk.SessionManager))
      throw new Error("The OMO plugin is bound to a different native session registry.");
  };
  const loadModules = async input => {
    const bun = globalThis.Bun;
    if (!compiled || typeof bun?.build !== "function" || typeof bun.Transpiler !== "function")
      throw new Error("This OMO process does not support scoped Bun module loading.");
    if (!(input?.modules instanceof Map))
      throw new Error("Cox requires an audited OMO entry and its transformed module map.");
    const { createHash, randomUUID } = await import("node:crypto");
    const modules = new Map();
    let bytes = 0;
    for (const [url, value] of input.modules) {
      const module = { ...value, url };
      if (typeof module?.url !== "string") throw new Error("Cox requires an audited OMO module URL.");
      const location = new URL(module.url);
      const filename = fileURLToPath(location);
      if (location.protocol !== "file:" || location.hash ||
          resolveModule(path.basename(filename)) !== pathToFileURL(filename).href ||
          typeof module.source !== "string" || Buffer.byteLength(module.source, "utf8") > 2 * 1024 * 1024 ||
          modules.has(module.url))
        throw new Error("The transformed OMO module does not belong to this installation or exceeds its limit.");
      bytes += Buffer.byteLength(module.source, "utf8");
      if (bytes > 16 * 1024 * 1024) throw new Error("The transformed OMO module graph exceeds its limit.");
      modules.set(module.url, { ...module });
    }
    if (!modules.has(input.entryUrl)) throw new Error("The audited OMO entry is missing from its module graph.");
    const token = createHash("sha256").update(JSON.stringify([...modules])).update(randomUUID()).digest("hex");
    const namespace = "cox-omo-scoped-" + token;
    const blocked = new Set(["#omo-memory-sync-runtime", "#omo-device-account-runtime", ...(input.blockedImports ?? [])]);
    const aliases = { ...input.aliases };
    const unavailable = name => "data:text/javascript," + encodeURIComponent('throw new Error(' + JSON.stringify("This OMO module is not available in the audited Cox memory graph: " + name) + ');');
    const nativeImport = new Function("specifier", "return import(specifier)");
    const parserPath = path.join(assets.packageRoot, "node_modules", "@code-yeongyu", "senpi-codemode", "node_modules", "@babel", "parser", "lib", "index.js");
    if (!exists(parserPath)) throw new Error("The official standalone parser for scoped OMO imports is unavailable.");
    const parser = await nativeImport(pathToFileURL(parserPath).href);
    const prepare = source => {
      const syntax = parser.parse(source, { sourceType: "module", createImportExpressions: true });
      const edits = [];
      const visit = node => {
        if (!node || typeof node !== "object") return;
        if (node.type === "ImportExpression" && node.source?.type !== "StringLiteral")
          edits.push({ start: node.source.start, end: node.source.end, text: JSON.stringify(unavailable("computed import")) });
        for (const [key, child] of Object.entries(node)) {
          if (["loc", "comments", "tokens"].includes(key)) continue;
          if (Array.isArray(child)) child.forEach(visit);
          else if (child && typeof child === "object") visit(child);
        }
      };
      visit(syntax);
      for (const edit of edits.sort((left, right) => right.start - left.start))
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
      return source;
    };
    const result = await bun.build({
      entrypoints: [namespace + ":entry"],
      target: "bun",
      format: "esm",
      splitting: false,
      write: false,
      plugins: [{ name: namespace, setup(builder) {
        builder.onResolve({ filter: /.*/ }, argument => {
          const name = argument.path;
          if (blocked.has(name) || name === "omo-sync" || name.startsWith("omo-sync/"))
            return { path: unavailable(name), external: true };
          if (name.startsWith("node:") || name.startsWith("bun:") || virtualModules.has(name))
            return { path: name, external: true };
          let url = name === namespace + ":entry" ? input.entryUrl : name;
          if (Object.hasOwn(aliases, name)) url = resolveModule(aliases[name]);
          else if (name.startsWith(".") && argument.importer.startsWith("file:")) {
            url = new URL(name, argument.importer).href;
          }
          if (!modules.has(url)) return { path: unavailable(name), external: true };
          return { path: url, namespace };
        });
        builder.onLoad({ filter: /.*/, namespace }, argument => {
          const module = modules.get(argument.path);
          if (!module) throw new Error("The audited Cox OMO module graph is incomplete.");
          const filename = fileURLToPath(argument.path);
          const metadata = { url: argument.path, filename, dirname: path.dirname(filename), path: filename, dir: path.dirname(filename) };
          const transpiler = new bun.Transpiler({ loader: "js", target: "bun", define: { "import.meta": JSON.stringify(metadata) } });
          return { contents: transpiler.transformSync(prepare(module.source)), loader: "js", resolveDir: assets.pluginRoot };
        });
      } }],
    });
    if (!result.success || result.outputs.length !== 1)
      throw new Error("The audited Cox OMO module graph could not be compiled.");
    const source = await result.outputs[0].text();
    const loaded = await nativeImport("data:text/javascript;base64," + Buffer.from(source).toString("base64"));
    modules.clear();
    return { ...loaded, dispose() {} };
  };
  return { ...assets, entry, tasks, sdk, resolveModule, resolveImport, assertNativeSession,
    loadModules: compiled ? loadModules : undefined };
}
`}`;
