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
  for (const key of Object.keys(memoryEnv))
    if (key !== "COX_MODEL_SERVICE_KEY" && /(?:KEY|TOKEN|PASSWORD|SECRET|^OMO_MEMORY_(?:SUPERVISOR|KILL|TEST)|^NODE_OPTIONS$)/i.test(key)) delete memoryEnv[key];
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
  const sourceHashes = {
    "omo.js": "907e403c374cdee81877d79ec1813adbca1d51d3101ea49b68a1cfb42832a632",
    "omo-task.js": "ae1f9b564c8ce70033620bfd9b08c19ba3f8ac825fa3ebc6b4a2efd5f5622250",
    "omo-memory-commands.js": "f98ebd5cc37e3d0dff8646063f50c59a8724f4e59f65724f55f8017e9d94193e",
    "omo-memory-memfs.js": "868fe0c25f75d8a528b9771a0ea99405cb6d31f1ee90cc6689f4725c0e4d1b3a",
    "omo-memory-doctor.js": "43d4c07fbad29697db3e23d2f6dfc9d1347fe23184b9cf085521244fdcb15ef4",
    "omo-memory-palace.js": "10cdfe689142e8c84072ba218c6a986db9711c39c989040c517dc5cf1b4046b9",
    "omo-recall-store.js": "258ba11f360b928f32debc2861d26becf1e836bd95466e978f8cf847f4634474",
    "memory-run-supervisor.mjs": "ca645f78833063f0632559832b33aa622bbfca12079c7d807a8cdacbc0404ccb",
  };
  const standaloneHashes = {
    "omo.js": "7e9246cf1150f77fa7ff3278fb554c752da01b8cc6be9bdf835d0e28463f42bd",
    "omo-task.js": "f60b0ab50f32081a139169951b317f059f37e6ba33ecd54ad39bf593ee430dad",
    "omo-memory-commands.js": "2cc8487b9a90f36c41158be8b8c6108fd2a6bae4817195bfde97f92e276bd08e",
    "omo-memory-memfs.js": "afc9da7bc4cb8dcdb2040eb95dced76839c23bf0edc851a75d899e1642a39963",
    "omo-memory-doctor.js": "c9d938ee0c38a9ab701aa7eaebe199d77acb3fab99ea783aa8f6332233df6625",
    "omo-memory-palace.js": "325c7c72ca92c28cff805aa423dbca2c1a48ef862db8d5b4f10d31e74c335ae7",
    "omo-recall-store.js": "b33c2a74075e818475b96af5ef90e1ef8a4d26e10f9940dc4c29909069652856",
    "memory-run-supervisor.mjs": "aa8b6a35651a46dfba5d53f6773997c88321ebaebb6d4a31e25052518865c2b9",
  };
  const replaceOne = (source, before, after) => {
    if (source.split(before).length !== 2) throw new Error("The pinned OMO memory integration interface changed.");
    return source.replace(before, after);
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
    let distribution;
    for (const [name, hash] of Object.entries(sourceHashes)) {
      const module = await readModule(name);
      const actual = typeof module.source === "string" ? createHash("sha256").update(module.source).digest("hex") : undefined;
      distribution ??= actual === hash ? sourceHashes : standaloneHashes;
      if (typeof module.source !== "string" || Buffer.byteLength(module.source, "utf8") > 2 * 1024 * 1024 ||
          actual !== distribution[name])
        throw new Error("Cox memory requires the verified OMO Native 5.1.69 runtime sources.");
      let source = module.source;
        if (source.includes('name:"post-commit",script:')) {
          const hook = /name:"post-commit",script:(?:'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*)/g;
          if ([...source.matchAll(hook)].length !== 1) throw new Error("The OMO memory mirror interface changed.");
          source = source.replace(hook, 'name:"post-commit",script:"#!/bin/sh\\nexit 0\\n"');
        }
      if (name === "omo.js") {
        source = replaceOne(source, "async run(e,r){let i=[...gP,...e]",
          'async run(e,r){if(e.some(v=>["push","fetch","pull","clone","ls-remote"].includes(v)))throw Error("Remote memory transport is disabled in Cox.");let i=[...gP,"-c","protocol.allow=never",...e]');
        source = replaceOne(source, "if(!e.oneShot||q5(t,e.exists))", "if(true)");
        source = replaceOne(source, "c=new M4({identity:f5(e),memoryRoot:", "c=new M4({...t.runnerOptions,env:t.env,supervisorPath:t.supervisorPath,identity:f5(e),memoryRoot:");
        source = replaceOne(source, "env:F2(e.env),hardDeadlineAt:", "env:F2({...e.env,COX_MODEL_SERVICE_KEY:undefined}),hardDeadlineAt:");
        source = replaceOne(source, "x=hae({sessions:o,loadConfig:t,cwd:l,env:r,now:n,logger:s.logger,",
          "x=hae({sessions:o,loadConfig:t,cwd:l,env:r,now:n,logger:s.logger,...e.wiringOptions,");
        source = replaceOne(source, "let u,f=new LH,p=v6(a,f)", "let u,f=e.work??new LH,p=v6(a,f)");
        source += '\nexport {mae as createMemoryComponent,Is as memorySettingsSchema,p5 as createMemoryRuntime,sie as FactsExtractor};\n';
      }
      const url = module.url ?? resolveModule(name);
      modules.set(url, { name, source });
    }
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
      if (gateway.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(gateway.hostname) || gateway.username || gateway.password || gateway.search || gateway.hash ||
          provider.apiKey !== "$COX_MODEL_SERVICE_KEY" || !["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(provider.api))
        throw new Error("Cox memory requires the loopback Cox model gateway.");
      const models = provider.models.filter(model => allowed.has("cox/" + model.id)).map(model =>
        Object.fromEntries(["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "thinkingLevelMap"]
          .filter(key => model[key] !== undefined).map(key => [key, model[key]])));
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
      memoryEnv.OMO_MEMORY_RUN_SUPERVISOR_PATH = await privateWrite("memory-run-supervisor.mjs", replaceOne(supervisor,
        "env:t.env,detached:!1", "env:{...t.env,COX_MODEL_SERVICE_KEY:process.env.COX_MODEL_SERVICE_KEY},detached:!1"));
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
