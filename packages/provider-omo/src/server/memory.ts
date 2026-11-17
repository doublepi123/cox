export const OMO_MEMORY_SOURCE = String.raw`
async function createCoxOmoMemoryComponent(options) {
  const { readFile, stat, mkdir, writeFile, rename, lstat, chmod } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const { registerHooks } = await import("node:module");
  const { join, isAbsolute } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const environment = options.env ?? process.env;
  const home = environment.COX_OMO_MEMORY_HOME;
  if (!home || !isAbsolute(home)) throw new Error("Cox requires an absolute instance memory directory.");
  const enabled = environment.COX_OMO_AUTOMATIC_MEMORY !== "0";
  const managed = environment.COX_OMO_MANAGED_MODELS === "1";
  const allowed = new Set(JSON.parse(environment.COX_OMO_ALLOWED_MODELS || "[]"));
  if (managed && [...allowed].some(model => typeof model !== "string" || !model.startsWith("cox/")))
    throw new Error("Cox memory requires exact models from the Cox gateway binding.");
  const config = options.config;
  const memoryEnv = { ...environment, OMO_MEMORY_HOME: home };
  delete memoryEnv.OMO_MEMORY_PUSH_SYNC;
  delete memoryEnv.OMO_MEMORY_RUN_SUPERVISOR_PATH;
  const gitConfigOverlay = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/;
  for (const key of Object.keys(memoryEnv))
    if (key !== "COX_MODEL_SERVICE_KEY" && (gitConfigOverlay.test(key) || /(?:KEY|TOKEN|PASSWORD|SECRET|^OMO_MEMORY_(?:SUPERVISOR|KILL|TEST)|^NODE_OPTIONS$)/i.test(key))) delete memoryEnv[key];
  let selected;
  const permit = model => managed && model?.provider === "cox" && allowed.has(model.provider + "/" + model.id);
  const reference = model => model?.provider && model?.id ? model.provider + "/" + model.id : undefined;
  const memoryConfig = native => {
    const quick = config.categories?.quick;
    const fixed = new Set(JSON.parse(environment.COX_OMO_FIXED_ROLES || "{}").categories || []);
    const explicit = fixed.has("quick") ? quick?.models?.[0] : undefined;
    const model = managed ? explicit || selected : undefined;
    if (managed && model && !allowed.has(model)) throw new Error("The memory model is outside this Cox binding.");
    const background = enabled && managed && typeof model === "string";
    const memory = native.parseMemorySettings({
      enabled,
      agent: "cox-global",
      sync: { enabled: false },
      project_scope: { nudge: false, recall: false },
      reflection: { enabled: background, category: "cox-memory", sandbox: "auto" },
      facts: { enabled: background, ...(model ? { model } : {}) },
      dream: { enabled: background, shutdown_launch: false },
      recall: { enabled: background, category: "cox-memory" },
    });
    return {
      config: {
        ...config,
        memory,
        categories: {
          ...config.categories,
          "cox-memory": {
            models: model ? [model] : [],
            models_distribution: "round_robin",
            ...(quick?.reasoning ? { reasoning: quick.reasoning } : {}),
          },
        },
      },
      diagnostics: [], layers: [], sources: [],
    };
  };
  const scopedObjects = new WeakMap();
  const scope = (target, runtime = false) => {
    if (!target || typeof target !== "object") throw new Error("Cox memory requires a scoped model registry.");
    const existing = scopedObjects.get(target);
    if (existing) return existing;
    const providers = new Set(["cox"]);
    const modelMethods = new Set(["stream", "streamSimple", "complete", "completeSimple", "classify", "generateImages",
      "getApiKeyAndHeaders", "getUpstreamModelId", "getServiceTier", "isUsingOAuth", "hasConfiguredAuth",
      "getCompatibilityRequestConfig", "getCompatibilityRequestHeaders", "getSessionAuth", "resolveModel",
      "prepareRequest", "prepareSimpleRequest", "streamDeferred", "fetchDeferred", "cancelDeferred"]);
    const providerMethods = new Set(["getProviderAuth", "getApiKeyForProvider", "getProvider", "getAuth", "checkAuth",
      "getProviderAuthStatus", "resolveProviderAuth", "providerAuthIsHeaderOnly", "getProviderDisplayName",
      "getRegisteredProviderConfig", "getRegisteredNativeProvider", "getProviderOrigin", "isFallbackEligible"]);
    const listMethods = new Set(["getAll", "getAvailable", "getModels", "getAllModels", "getAllAvailable",
      "getAvailableSnapshot", "getModelsOfType", "getAvailableOfType"]);
    const proxy = new Proxy(target, {
      get(object, key) {
        if (key === "modelRuntime" || key === "runtime") return scope(Reflect.get(object, key, object), true);
        if (key === "authStorage") return undefined;
        if (key === "getProviders") return () => object.getProviders().filter(provider => providers.has(provider.id));
        if (key === "getRegisteredProviderIds" || key === "providerIds") return () => ["cox"];
        if (runtime && (key === "hasConfiguredAuth" || key === "isUsingOAuth")) return provider => {
          if (provider !== "cox" || !managed) throw new Error("The requested memory provider is outside this Cox binding.");
          return object[key](provider);
        };
        if (listMethods.has(key)) return (...args) => {
          const result = object[key](...args);
          return result instanceof Promise ? result.then(models => models.filter(permit)) : result.filter(permit);
        };
        if (["find", "getModel", "getPhysicalModel", "getModelOfType", "findOfType"].includes(key)) return (...args) => {
          const model = object[key](...args);
          return permit(model) ? model : undefined;
        };
        if (modelMethods.has(key)) return (model, ...args) => {
          if (!permit(model)) throw new Error("The requested memory model is outside this Cox binding.");
          const bound = object[runtime ? "getModel" : "find"]("cox", model.id);
          if (!bound) throw new Error("Cox memory refused an unregistered model object.");
          return object[key](bound, ...args);
        };
        if (providerMethods.has(key)) return (provider, ...args) => {
          if (typeof provider === "object") {
            if (!permit(provider)) throw new Error("The requested memory model is outside this Cox binding.");
            const bound = object[runtime ? "getModel" : "find"]("cox", provider.id);
            if (!bound) throw new Error("Cox memory refused an unregistered model object.");
            return object[key](bound, ...args);
          } else if (!providers.has(provider) || !managed) throw new Error("The requested memory provider is outside this Cox binding.");
          return object[key](provider, ...args);
        };
        if (typeof key === "string" && /^(register|unregister|setRuntime|removeRuntime|login|logout|listCredentials)/.test(key))
          return () => { throw new Error("Cox memory cannot change model providers or credentials."); };
        if (typeof key === "string" && ["credentials", "config", "models", "providers", "snapshot", "pool"].includes(key)) return undefined;
        const value = Reflect.get(object, key, object);
        return typeof value === "function" ? value.bind(object) : value;
      },
    });
    scopedObjects.set(target, proxy);
    return proxy;
  };
  const applyOnce = (source, pattern, rewrite) => {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
    if ([...source.matchAll(global)].length !== 1) return { source, applied: false };
    return { source: source.replace(pattern, rewrite), applied: true };
  };
  const loadNative = async () => {
    const root = options.root;
    if (!root || !isAbsolute(root)) throw new Error("Cox requires an absolute OMO runtime root.");
    const resolveModule = options.resolveModule ?? (name => pathToFileURL(join(root, "plugin", "extensions", name)).href);
    const readModule = options.readModule ?? (async name => {
      const url = resolveModule(name);
      const file = new URL(url);
      const size = (await stat(file)).size;
      if (size > 2 * 1024 * 1024) throw new Error("The OMO memory module exceeds the source limit.");
      return { url, source: await readFile(file, "utf8") };
    });
    const modules = new Map();
    const applied = new Set();
    const names = ["omo.js", "omo-task.js", "omo-memory-commands.js", "omo-memory-memfs.js",
      "omo-memory-doctor.js", "omo-memory-palace.js", "omo-recall-store.js", "memory-run-supervisor.mjs"];
    for (const name of names) {
      const module = await readModule(name);
      if (typeof module.source !== "string" || Buffer.byteLength(module.source, "utf8") > 2 * 1024 * 1024)
        throw new Error("The OMO memory module exceeds the source limit or is not text.");
      let source = module.source;
      if (source.includes('name:"post-commit",script:')) {
        const patched = applyOnce(source, /name:"post-commit",script:(?:'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*)/,
          'name:"post-commit",script:"#!/bin/sh\\nexit 0\\n"');
        source = patched.source;
        if (patched.applied) applied.add("post-commit");
      }
      if (name === "memory-run-supervisor.mjs") {
        const patched = applyOnce(source, /env:(\w+\.env),detached:!1/,
          "env:{...$1,COX_MODEL_SERVICE_KEY:process.env.COX_MODEL_SERVICE_KEY},detached:!1");
        source = patched.source;
        if (patched.applied) applied.add("supervisor-key");
      }
      if (name === "omo.js") {
        const component = [...source.matchAll(/function (\w+)\(/g)].reverse().find(match =>
          source.slice(match.index, match.index + 1200).includes('return{name:"memory",register('));
        const schema = source.match(/function \w+\(e\)\{return e\?\?(\w+)\.parse\(\{\}\)\}/);
        const runtimeFn = [...source.matchAll(/function (\w+)\(\w+,\w+\)\{/g)].reverse().find(match =>
          /new \w+\(\{identity:\w+\(\w+\),memoryRoot:/.test(source.slice(match.index, match.index + 800)));
        const facts = source.match(/createFactsExtractor\?\?\(e=>new (\w+)\(e\)\)/);
        const git = applyOnce(source, /async run\((\w+),(\w+)\)\{let (\w+)=\[\.\.\.(\w+),\.\.\.\1\]/,
          'async run($1,$2){if($1.some(v=>["push","fetch","pull","clone","ls-remote"].includes(v)))throw Error("Remote memory transport is disabled in Cox.");let $3=[...$4,"-c","protocol.allow=never",...$1]');
        source = git.source;
        if (git.applied) applied.add("git-remote");
        const oneshot = applyOnce(source, /if\(!\w+\.oneShot\|\|\w+\(\w+,\w+\.exists\)\)/, "if(true)");
        source = oneshot.source;
        if (oneshot.applied) applied.add("oneshot");
        const runner = applyOnce(source, /(\w+=new \w+\()\{identity:(\w+\(\w+\)),memoryRoot:/,
          "$1{...t.runnerOptions,env:t.env,supervisorPath:t.supervisorPath,identity:$2,memoryRoot:");
        source = runner.source;
        if (runner.applied) applied.add("runner-options");
        const envKey = applyOnce(source, /env:(\w+)\((\w+)\.env\),hardDeadlineAt:/,
          "env:$1({...$2.env,COX_MODEL_SERVICE_KEY:undefined}),hardDeadlineAt:");
        source = envKey.source;
        if (envKey.applied) applied.add("strip-gateway-key");
        const wiring = applyOnce(source, /(\w+=\w+\(\{sessions:\w+,loadConfig:\w+,cwd:\w+,env:\w+,now:\w+,logger:\w+\.logger,)/,
          "$1...e.wiringOptions,");
        source = wiring.source;
        if (wiring.applied) applied.add("wiring");
        const work = applyOnce(source, /let (\w+),(\w+)=new (\w+),(\w+)=(\w+)\((\w+),\2\)/,
          "let $1,$2=e.work??new $3,$4=$5($6,$2)");
        source = work.source;
        if (work.applied) applied.add("work-tracker");
        if (component && schema && runtimeFn && facts) {
          source += "\nexport {" + component[1] + " as createMemoryComponent," + schema[1] + " as memorySettingsSchema," + runtimeFn[1] + " as createMemoryRuntime," + facts[1] + " as FactsExtractor};\n";
          applied.add("exports");
        }
      }
      const url = module.url ?? resolveModule(name);
      modules.set(url, { name, source });
    }
    const required = ["git-remote", "strip-gateway-key", "exports"];
    if (managed) required.push("supervisor-key");
    const failed = required.filter(label => !applied.has(label));
    if (failed.length > 0)
      throw new Error("Cox could not apply required OMO memory compatibility patches (" + failed.join(", ") +
        "). Automatic memory is disabled until the OMO runtime matches a supported interface.");
    const privateDirectory = join(home, "runtime", "cox");
    const privateWrite = async (name, source) => {
      const file = join(privateDirectory, name);
      const existing = await lstat(file).catch(error => { if (error.code !== "ENOENT") throw error; });
      if (existing?.isSymbolicLink() || existing && !existing.isFile()) throw new Error("Cox memory runtime files cannot be symbolic links.");
      const temporary = file + "." + process.pid + ".new";
      await writeFile(temporary, source, { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
      return file;
    };
    if (managed) {
      const agentDir = environment.OMO_CODING_AGENT_DIR ?? environment.SENPI_CODING_AGENT_DIR;
      if (!agentDir || !isAbsolute(agentDir)) throw new Error("Cox memory requires the isolated gateway model catalog.");
      const catalogPath = join(agentDir, "models.json");
      if ((await stat(catalogPath)).size > 1024 * 1024) throw new Error("The Cox memory model catalog exceeds its limit.");
      const provider = JSON.parse(await readFile(catalogPath, "utf8")).providers?.cox;
      const gateway = new URL(provider?.baseUrl);
      const validGatewayApis = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];
      const validLoopbackUrl = rawUrl => {
        const parsed = new URL(rawUrl);
        return parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname) &&
          parsed.origin === gateway.origin && !parsed.username && !parsed.password && !parsed.search && !parsed.hash;
      };
      if (!validLoopbackUrl(provider?.baseUrl) || provider.apiKey !== "$COX_MODEL_SERVICE_KEY" || !validGatewayApis.includes(provider.api))
        throw new Error("Cox memory requires the loopback Cox model gateway.");
      const models = provider.models.filter(model => allowed.has("cox/" + model.id)).map(model => {
        if (model.api !== undefined && !validGatewayApis.includes(model.api))
          throw new Error("Cox memory model uses an unsupported gateway API.");
        if (model.baseUrl !== undefined && !validLoopbackUrl(model.baseUrl))
          throw new Error("Cox memory model requires the loopback Cox model gateway.");
        return Object.fromEntries(["id", "name", "api", "baseUrl", "compat", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"]
          .filter(key => model[key] !== undefined).map(key => [key, model[key]]));
      });
      if (models.length !== allowed.size) throw new Error("The Cox memory model catalog does not match this binding.");
      await mkdir(privateDirectory, { recursive: true, mode: 0o700 });
      if ((await lstat(privateDirectory)).isSymbolicLink()) throw new Error("Cox memory runtime cannot be a symbolic link.");
      await chmod(privateDirectory, 0o700);
      await privateWrite("models.json", JSON.stringify({ providers: { cox: { baseUrl: provider.baseUrl, api: provider.api, apiKey: "$COX_MODEL_SERVICE_KEY", models } } }));
      const gatewayTimeoutMs = Number(environment.COX_OMO_GATEWAY_TIMEOUT_MS);
      const gatewayTimeout = Number.isSafeInteger(gatewayTimeoutMs) && gatewayTimeoutMs >= 30_100 && gatewayTimeoutMs <= 1_830_000
        ? gatewayTimeoutMs : undefined;
      await privateWrite("settings.json", JSON.stringify({
        ...(gatewayTimeout === undefined ? {} : { httpIdleTimeoutMs: gatewayTimeout }),
        retry: { enabled: false, modelFallback: false, fallbackChains: {},
          ...(gatewayTimeout === undefined ? {} : { provider: { timeoutMs: gatewayTimeout, streamStartTimeoutMs: gatewayTimeout, keepAliveTimeoutMs: gatewayTimeout } }) },
        packages: [], extensions: [], skills: [] }));
      await privateWrite("auth.json", "{}");
      const supervisor = modules.get(resolveModule("memory-run-supervisor.mjs")).source;
      memoryEnv.OMO_MEMORY_RUN_SUPERVISOR_PATH = await privateWrite("memory-run-supervisor.mjs", supervisor);
      for (const key of ["OMO_CODING_AGENT_DIR", "SENPI_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"]) memoryEnv[key] = privateDirectory;
    }
    const entryUrl = resolveModule("omo.js");
    const token = createHash("sha256").update(home).digest("hex").slice(0, 16);
    const nativeUrls = new Map([...modules].map(([url]) => [url, url + "?cox-memory=" + token]));
    const aliases = {
      "#omo-task-runtime": "omo-task.js",
      "#omo-memory-commands-runtime": "omo-memory-commands.js",
      "#omo-memory-memfs-runtime": "omo-memory-memfs.js",
      "#omo-memory-doctor-runtime": "omo-memory-doctor.js",
      "#omo-memory-palace-runtime": "omo-memory-palace.js",
      "#omo-recall-store-runtime": "omo-recall-store.js",
      "#memory-completion-links": "omo-memory-commands.js",
      "#memory-external-projection": "omo-recall-store.js",
    };
    const resolve = (specifier, parentURL) => {
      if ([...nativeUrls.values()].includes(specifier)) return specifier;
      if (parentURL && [...nativeUrls.values()].includes(parentURL)) {
        if (specifier === "#omo-memory-sync-runtime" || specifier === "#omo-device-account-runtime")
          throw new Error("Remote memory synchronization is disabled in Cox.");
        if (aliases[specifier]) {
          const url = resolveModule(aliases[specifier]);
          return nativeUrls.get(url) ?? url;
        }
        if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.includes(":"))
          return options.resolveImport?.(specifier);
      }
    };
    if (options.loadModules) {
      const module = await options.loadModules({ entryUrl, modules, aliases,
        blockedImports: ["#omo-memory-sync-runtime", "#omo-device-account-runtime"] });
      return { ...module, parseMemorySettings: value => module.memorySettingsSchema.parse(value),
        createFactsExtractor: value => new module.FactsExtractor(value), dispose: module.dispose };
    }
    if (typeof registerHooks !== "function") throw new Error("This OMO engine requires a safe native memory module loader.");
    const hook = registerHooks({
      resolve(specifier, context, nextResolve) {
        const resolved = resolve(specifier, context.parentURL);
        if (resolved) return { url: resolved, shortCircuit: true };
        if (context.parentURL && [...nativeUrls.values()].includes(context.parentURL)) {
          if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.includes(":")) {
            return nextResolve(specifier, { ...context, parentURL: entryUrl });
          }
        }
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        const original = [...nativeUrls].find(([, nativeUrl]) => nativeUrl === url)?.[0];
        if (original) return { format: "module", source: modules.get(original).source, shortCircuit: true };
        return nextLoad(url, context);
      },
    });
    try {
      const { compileFunction, constants } = await import("node:vm");
      const nativeImport = compileFunction("return import(specifier)", ["specifier"],
        { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });
      const module = await nativeImport(nativeUrls.get(entryUrl));
      return { ...module, parseMemorySettings: value => module.memorySettingsSchema.parse(value),
        createFactsExtractor: value => new module.FactsExtractor(value), dispose: () => hook.deregister() };
    } catch (error) {
      hook.deregister();
      throw error;
    }
  };
  if (!enabled) return { name: "memory", register() {} };
  const native = options.native ?? await loadNative();
  if (typeof native.createMemoryComponent !== "function" || typeof native.parseMemorySettings !== "function")
    throw new Error("The OMO runtime does not expose safe memory integration interfaces.");
  const loadConfig = () => memoryConfig(native);
  const runtimes = new Set();
  let lifecycle;
  let custody;
  let workSequence = 0;
  const workGeneration = crypto.randomUUID();
  const ownedWork = new Set();
  const running = new Set();
  const recoverWork = ctx => {
    const sessionId = ctx?.sessionManager?.getSessionId();
    if (!custody || typeof sessionId !== "string") return;
    const records = new Map();
    for (const entry of ctx.sessionManager.getEntries()) {
      const value = entry.type === "custom" && entry.customType === "work-custody" ? entry.data : undefined;
      if (value && value.sessionId === sessionId && typeof value.id === "string") records.set(value.id, value);
    }
    for (const value of records.values()) {
      if (value.kind !== "background" || value.state !== "open" ||
        value.detail !== "Local automatic memory" || typeof value.key !== "string" ||
        !/^cox-memory:[1-9]\d*:[1-9]\d*(?::[0-9a-f-]{36})?$/.test(value.key) ||
        value.ticketId !== undefined || value.payload !== undefined || ownedWork.has(value.key)) continue;
      custody.open(value.key, "background", value.detail).close("cancelled");
    }
  };
  const work = {
    track(action) {
      const key = "cox-memory:" + process.pid + ":" + ++workSequence + ":" + workGeneration;
      const token = custody?.open(key, "background", "Local automatic memory");
      if (token) ownedWork.add(key);
      let result;
      try { result = Promise.resolve(action()); }
      catch (error) { ownedWork.delete(key); token?.close("cancelled"); throw error; }
      const finish = reason => { running.delete(settled); ownedWork.delete(key); token?.close(reason); };
      const settled = result.then(() => finish("consumed"), () => finish("cancelled"));
      running.add(settled);
      return result;
    },
    async settled() { while (running.size > 0) await Promise.allSettled([...running]); },
  };
  const trackedMethods = (target, methods) => new Proxy(target, {
    get(object, key) {
      const value = Reflect.get(object, key, object);
      if (methods.includes(key)) return (...args) => work.track(() => value.apply(object, args));
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
  const component = native.createMemoryComponent({
    env: memoryEnv,
    loadConfig,
    work,
    deviceAccount: async () => null,
    syncRunner: {
      acquire() {}, async release() {}, async status() { return null; }, deviceName() { return undefined; },
    },
    createRuntime: (identity, runtime) => {
      const created = native.createMemoryRuntime(identity, {
      ...runtime,
      env: memoryEnv,
      supervisorPath: memoryEnv.OMO_MEMORY_RUN_SUPERVISOR_PATH,
      runnerOptions: options.reflectionOptions,
      resolveAgentDir: () => memoryEnv.OMO_CODING_AGENT_DIR,
      resolveParentSessionFile: () => undefined,
      resolveParentContextTokens: () => undefined,
      resolveParentCacheReusable: () => false,
      });
      runtimes.add(created);
      return trackedMethods(created, ["launch", "reconcile"]);
    },
    wiringOptions: {
      ...options.wiringOptions,
      createFactsExtractor: value => trackedMethods(native.createFactsExtractor({ ...value, ...options.factsOptions }),
        ["launchPending", "reconcilePending", "cancelActive"]),
    },
  });
  const contexts = new WeakMap();
  const scopeContext = ctx => {
    if (!ctx || typeof ctx !== "object") return ctx;
    if (ctx.model && managed && !permit(ctx.model)) throw new Error("The main memory model is outside this Cox binding.");
    if (ctx.model) selected = reference(ctx.model);
    const existing = contexts.get(ctx);
    if (existing) return existing;
    const proxy = new Proxy(ctx, {
      get(target, key) {
        if (key === "modelRegistry") return scope(target.modelRegistry);
        if (key === "agentDir" && memoryEnv.OMO_CODING_AGENT_DIR) return memoryEnv.OMO_CODING_AGENT_DIR;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    contexts.set(ctx, proxy);
    return proxy;
  };
  return {
    name: "memory",
    async register(pi, context) {
      lifecycle = pi.lifecycle;
      if (managed && !options.native && !lifecycle)
        throw new Error("Cox memory requires native background lifecycle custody.");
      pi.on("session_start", (_event, ctx) => {
        custody = lifecycle?.obligations;
        recoverWork(ctx);
      });
      const owned = new Proxy(pi, {
        get(target, key) {
          if (key === "on") return (name, handler, hookOptions) => target.on(name, (event, ctx, ...args) => {
            custody = lifecycle?.obligations;
            return handler(event, scopeContext(ctx), ...args);
          }, hookOptions);
          if (key === "rpc") return target.rpc && new Proxy(target.rpc, {
            get(rpc, property) {
              if (property === "handle") return (name, handler) => {
                if (name.startsWith("omo.memory.sync") || name.startsWith("omo.memory.account") || name.startsWith("omo.memory.device")) return;
                return rpc.handle(name, handler);
              };
              const value = Reflect.get(rpc, property, rpc);
              return typeof value === "function" ? value.bind(rpc) : value;
            },
          });
          if (key === "registerCommand") return (name, command) => {
            if (name === "memory-repository") return;
            if (name === "memfs") return target.registerCommand(name, {
              ...command,
              handler: (args, ctx) => {
                if (!/^(?:status|init|diff|tokens|repair)(?:\s|$)/.test(args.trim()))
                  throw new Error("Remote memory transport and memory imports are disabled in Cox.");
                return command.handler(args, scopeContext(ctx));
              },
            });
            return target.registerCommand(name, { ...command, handler: (args, ctx) => command.handler(args, scopeContext(ctx)) });
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await component.register(owned, context);
      } catch (error) {
        native.dispose?.();
        throw error;
      }
    },
    loadConfig,
    scopeModelRegistry: scope,
    whenIdle: async () => { await Promise.all([...runtimes].map(runtime => runtime.settled())); await work.settled(); },
    dispose: () => native.dispose?.(),
  };
}
`;
