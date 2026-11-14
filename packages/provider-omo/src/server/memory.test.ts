import { describe, expect, it } from "vite-plus/test";
import { OMO_MEMORY_SOURCE } from "./memory.ts";

type Model = { readonly provider: string; readonly id: string; readonly baseUrl?: string };
type Handler = (
  event: unknown,
  ctx?: {
    model?: Model;
    modelRegistry?: object;
    sessionManager?: { getSessionId(): string; getEntries(): ReadonlyArray<unknown> };
  },
) => unknown;
type NativeConfig = {
  readonly config: {
    readonly memory: {
      readonly enabled: boolean;
      readonly agent: string;
      readonly sync: { readonly enabled: boolean };
      readonly reflection: { readonly enabled: boolean; readonly category: string };
      readonly recall: { readonly enabled: boolean; readonly category: string };
      readonly facts: { readonly enabled: boolean; readonly model?: string };
      readonly dream: { readonly enabled: boolean; readonly shutdown_launch: boolean };
    };
    readonly categories: Record<string, { readonly models: string[] }>;
  };
  readonly sources: unknown[];
};
type Registry = {
  readonly modelRuntime?: Registry;
  readonly runtime?: Registry;
  readonly authStorage?: unknown;
  readonly credentials?: unknown;
  getAll(): Model[];
  getAvailable(): Model[];
  find(provider: string, id: string): Model | undefined;
  getModel(provider: string, id: string): Model | undefined;
  getModelsOfType(type: string, provider?: string): Model[];
  getProviderAuth(provider: string): unknown;
  getAuth(provider: string | Model): unknown;
  stream(model: Model): unknown;
  registerProvider(provider: string): unknown;
};
type Component = {
  readonly name: string;
  register(pi: object, context: object): Promise<void>;
  loadConfig(): NativeConfig;
  scopeModelRegistry(registry: object): Registry;
  dispose(): void;
};
type NativeOptions = {
  readonly loadConfig: () => NativeConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly deviceAccount: () => Promise<null>;
  readonly syncRunner: { acquire(): void; status(): Promise<null> };
  readonly createRuntime: (identity: object, options: object) => unknown;
  readonly work: { track<A>(action: () => Promise<A>): Promise<A>; settled(): Promise<void> };
};
type Pi = {
  on(name: string, handler: Handler): void;
  registerCommand(
    name: string,
    command: { handler: (args: string, ctx?: object) => unknown },
  ): void;
  rpc: { handle(name: string, handler: () => unknown): void };
};

const loadFactory = async () => {
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(`${OMO_MEMORY_SOURCE}\nexport {createCoxOmoMemoryComponent};`).toString("base64")}`
  );
  return module.createCoxOmoMemoryComponent as (options: {
    readonly root?: string;
    readonly config: object;
    readonly env: NodeJS.ProcessEnv;
    readonly native?: object;
    readonly readModule?: (name: string) => Promise<{ readonly source: string }>;
  }) => Promise<Component>;
};

async function fixture(
  options: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly register?: (pi: Pi) => void;
    readonly lifecycle?: object;
  } = {},
) {
  let nativeOptions: NativeOptions | undefined;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx?: object) => unknown }>();
  const rpcs = new Map<string, () => unknown>();
  const factory = await loadFactory();
  const component = await factory({
    config: { categories: { quick: { models: ["cox/configured"] } }, memory: { enabled: false } },
    env: {
      COX_OMO_MEMORY_HOME: "/fixture/cox/instance/memory",
      COX_OMO_ALLOWED_MODELS: JSON.stringify(["cox/main", "cox/switched", "cox/configured"]),
      COX_OMO_MANAGED_MODELS: "1",
      OMO_MEMORY_HOME: "/outside/native-memory",
      OMO_MEMORY_PUSH_SYNC: "0",
      OMO_MEMORY_RUN_SUPERVISOR_PATH: "/outside/supervisor",
      ...options.environment,
    },
    native: {
      parseMemorySettings: (value: unknown) => value,
      createMemoryComponent: (value: NativeOptions) => {
        nativeOptions = value;
        return {
          register: (pi: Pi) => {
            pi.on("before_agent_start", () => undefined);
            options.register?.(pi);
          },
        };
      },
    },
  });
  await component.register(
    {
      ...(options.lifecycle ? { lifecycle: options.lifecycle } : {}),
      on: (name: string, handler: Handler) => handlers.set(name, handler),
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx?: object) => unknown },
      ) => commands.set(name, command),
      rpc: { handle: (name: string, handler: () => unknown) => rpcs.set(name, handler) },
    },
    {},
  );
  return { component, handlers, commands, rpcs, nativeOptions };
}

describe("Cox native global memory", () => {
  it("recovers only abandoned process-local memory custody in the restored session", async () => {
    const entry = (id: string, patch: Record<string, unknown> = {}) => ({
      type: "custom",
      customType: "work-custody",
      data: {
        id,
        key: `cox-memory:114328:${id}`,
        sessionId: "restored",
        state: "open",
        kind: "background",
        detail: "Local automatic memory",
        ...patch,
      },
    });
    const entries = [
      entry("125"),
      entry("127"),
      entry("128", { key: `cox-memory:${process.pid}:1:00000000-0000-4000-8000-000000000001` }),
      entry("129"),
      entry("129", { state: "settled" }),
      entry("130", { sessionId: "other-session" }),
      entry("131", { kind: "children" }),
      entry("132", { key: "other-extension:1" }),
      entry("133", { key: "cox-memory:unknown" }),
      entry("134", { state: "queued", ticketId: "delivery", payload: {} }),
      entry("135", { ticketId: "delivery" }),
      entry("136", { detail: "Other work" }),
      entry("137", { state: "consumed" }),
    ];
    const recovered: string[] = [];
    const { handlers } = await fixture({
      lifecycle: {
        obligations: {
          open: (key: string) => ({
            close: (reason: string) => {
              expect(reason).toBe("cancelled");
              recovered.push(key);
            },
          }),
        },
      },
    });
    await handlers.get("session_start")?.(
      {},
      {
        sessionManager: { getSessionId: () => "restored", getEntries: () => entries },
      },
    );
    expect(recovered).toEqual(entries.slice(0, 3).map((value) => value.data.key));
  });

  it("preserves live memory work on repeated session starts and gives new owners distinct keys", async () => {
    const open = new Set<string>();
    const entries: Array<{ type: string; customType: string; data: Record<string, unknown> }> = [];
    const lifecycle = {
      obligations: {
        open: (key: string, kind: string, detail: string) => {
          open.add(key);
          entries.push({
            type: "custom",
            customType: "work-custody",
            data: {
              id: key,
              key,
              kind,
              detail,
              state: "open",
              sessionId: "live",
            },
          });
          return { close: () => open.delete(key) };
        },
      },
    };
    const first = await fixture({ lifecycle });
    const ctx = { sessionManager: { getSessionId: () => "live", getEntries: () => entries } };
    await first.handlers.get("session_start")?.({}, ctx);
    let finish!: () => void;
    const pending = first.nativeOptions!.work.track(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const firstKey = [...open][0];
    await first.handlers.get("session_start")?.({}, ctx);
    expect([...open]).toEqual([firstKey]);
    const second = await fixture({ lifecycle });
    second.handlers.get("before_agent_start")?.({});
    await second.nativeOptions!.work.track(async () => {
      expect(open.size).toBe(2);
    });
    expect([...open]).toEqual([firstKey]);
    finish();
    await pending;
    expect(open.size).toBe(0);
  });

  it("holds native background custody until asynchronous memory finishes and cancels it without unhandled rejections on failure", async () => {
    const open = new Map<string, string>();
    const closed: Array<string> = [];
    const unhandled: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { nativeOptions, handlers } = await fixture({
        lifecycle: {
          obligations: {
            open: (key: string, kind: string) => {
              expect(kind).toBe("background");
              open.set(key, "open");
              return {
                close: (reason: string) => {
                  open.delete(key);
                  closed.push(reason);
                },
              };
            },
          },
        },
      });
      handlers.get("before_agent_start")?.({});
      let finish: (() => void) | undefined;
      const pending = nativeOptions?.work.track(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      expect(open.size).toBe(1);
      finish?.();
      await pending;
      await nativeOptions?.work.settled();
      expect(open.size).toBe(0);
      expect(closed).toEqual(["consumed"]);

      let rejectHook: ((reason?: unknown) => void) | undefined;
      const hookResult = new Promise<never>((_resolve, reject) => {
        rejectHook = reject;
      });
      void nativeOptions?.work.track(() => hookResult);
      rejectHook?.(new Error("Hook failure"));
      await expect(hookResult).rejects.toThrow("Hook failure");
      await nativeOptions?.work.settled();
      await expect(
        nativeOptions?.work.track(async () => {
          throw new Error("Direct failure");
        }),
      ).rejects.toThrow("Direct failure");
      await nativeOptions?.work.settled();
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(open.size).toBe(0);
      expect(closed).toEqual(["consumed", "cancelled", "cancelled"]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
  it("keeps local memory global and disables every background model until a bound main model is known", async () => {
    const { component, nativeOptions } = await fixture();
    expect(component.name).toBe("memory");
    const { memory } = component.loadConfig().config;
    expect(memory).toMatchObject({
      enabled: true,
      agent: "cox-global",
      sync: { enabled: false },
      reflection: { enabled: false },
      facts: { enabled: false },
      recall: { enabled: false },
      dream: { enabled: false, shutdown_launch: false },
    });
    expect(nativeOptions?.env.OMO_MEMORY_HOME).toBe("/fixture/cox/instance/memory");
    expect(nativeOptions?.env.OMO_MEMORY_PUSH_SYNC).toBeUndefined();
    expect(nativeOptions?.env.OMO_MEMORY_RUN_SUPERVISOR_PATH).toBeUndefined();
    expect(await nativeOptions?.deviceAccount()).toBeNull();
    expect(await nativeOptions?.syncRunner.status()).toBeNull();
    expect(component.loadConfig().sources).toEqual([]);
  });

  it("pins reflection, facts and Kibitzer to the selected main model and follows main-model switches", async () => {
    const { component, handlers } = await fixture();
    handlers.get("before_agent_start")?.({}, { model: { provider: "cox", id: "main" } });
    expect(component.loadConfig().config.memory).toMatchObject({
      reflection: { enabled: true, category: "cox-memory" },
      recall: { enabled: true, category: "cox-memory" },
      facts: { enabled: true, model: "cox/main" },
    });
    expect(component.loadConfig().config.categories["cox-memory"]?.models).toEqual(["cox/main"]);
    handlers.get("before_agent_start")?.({}, { model: { provider: "cox", id: "switched" } });
    expect(component.loadConfig().config.memory.facts.model).toBe("cox/switched");
    expect(component.loadConfig().config.categories["cox-memory"]?.models).toEqual([
      "cox/switched",
    ]);
    expect(() =>
      handlers.get("before_agent_start")?.({}, { model: { provider: "anthropic", id: "outside" } }),
    ).toThrow("outside");
  });

  it("honors only an explicitly selected quick model, without falling back outside the binding", async () => {
    const { component, handlers } = await fixture({
      environment: { COX_OMO_FIXED_ROLES: '{"categories":["quick"]}' },
    });
    handlers.get("before_agent_start")?.({}, { model: { provider: "cox", id: "main" } });
    expect(component.loadConfig().config.memory.facts.model).toBe("cox/configured");
    const foreign = await fixture({
      environment: {
        COX_OMO_FIXED_ROLES: '{"categories":["quick"]}',
        COX_OMO_ALLOWED_MODELS: '["cox/main"]',
      },
    });
    expect(() => foreign.component.loadConfig()).toThrow("outside");
  });

  it("does not allow independent configurations to use ambient background model credentials", async () => {
    const { component, handlers } = await fixture({ environment: { COX_OMO_MANAGED_MODELS: "0" } });
    handlers.get("before_agent_start")?.({}, { model: { provider: "anthropic", id: "outside" } });
    expect(component.loadConfig().config.memory).toMatchObject({
      enabled: true,
      facts: { enabled: false },
      reflection: { enabled: false },
      recall: { enabled: false },
      dream: { enabled: false },
    });
    expect(component.loadConfig().config.memory.facts.model).toBeUndefined();
    expect(component.loadConfig().config.categories["cox-memory"]?.models).toEqual([]);
  });

  it("does not register memory when the user opts out", async () => {
    const { handlers, nativeOptions } = await fixture({
      environment: { COX_OMO_AUTOMATIC_MEMORY: "0" },
    });
    expect(handlers.size).toBe(0);
    expect(nativeOptions).toBeUndefined();
  });

  it("blocks cloud/device enrollment RPCs, mirror commands, sync and imports", async () => {
    const { commands, rpcs } = await fixture({
      register: (pi) => {
        for (const name of ["memory-repository", "memfs", "memory"])
          pi.registerCommand(name, { handler: (args) => args });
        for (const name of [
          "omo.memory.sync.enable",
          "omo.memory.account.join",
          "omo.memory.device.approve",
          "omo.memory.status",
        ])
          pi.rpc.handle(name, () => undefined);
      },
    });
    expect([...commands.keys()]).toEqual(["memfs", "memory"]);
    expect([...rpcs.keys()]).toEqual(["omo.memory.status"]);
    expect(commands.get("memfs")?.handler("status")).toBe("status");
    for (const args of [
      "sync",
      "sync origin",
      "restore /outside",
      "reset",
      "backup https://example.invalid",
    ])
      expect(() => commands.get("memfs")?.handler(args)).toThrow("disabled");
  });

  it("scopes registry and underlying model runtime, refusing foreign providers and forged model URLs", async () => {
    const { component } = await fixture();
    const main: Model = { provider: "cox", id: "main", baseUrl: "http://127.0.0.1/gateway" };
    const foreign: Model = { provider: "anthropic", id: "outside" };
    const runtime = {
      credentials: "outside-credentials",
      getAll: () => [main, foreign],
      getAvailable: () => [main, foreign],
      getModelsOfType: () => [main, foreign],
      find: (provider: string, id: string) =>
        [main, foreign].find((model) => model.provider === provider && model.id === id),
      getModel: (provider: string, id: string) =>
        [main, foreign].find((model) => model.provider === provider && model.id === id),
      getAuth: (provider: string | Model) => provider,
      getProviderAuth: (provider: string) => provider,
      stream: (model: Model) => model.baseUrl,
      registerProvider: (provider: string) => provider,
    };
    const scoped = component.scopeModelRegistry({
      ...runtime,
      authStorage: "outside-auth",
      modelRuntime: runtime,
      runtime,
    });
    expect(scoped.getAll()).toEqual([main]);
    expect(scoped.getModelsOfType("chat")).toEqual([main]);
    expect(scoped.find("anthropic", "outside")).toBeUndefined();
    expect(scoped.authStorage).toBeUndefined();
    expect(scoped.modelRuntime?.credentials).toBeUndefined();
    expect(scoped.modelRuntime?.getAll()).toEqual([main]);
    expect(scoped.stream(main)).toBe(main.baseUrl);
    expect(scoped.stream({ ...main, baseUrl: "https://outside.invalid" })).toBe(main.baseUrl);
    expect(() => scoped.stream(foreign)).toThrow("outside");
    expect(() => scoped.getProviderAuth("anthropic")).toThrow("outside");
    expect(() => scoped.modelRuntime?.getAuth("anthropic")).toThrow("outside");
    expect(() => scoped.modelRuntime?.stream(foreign)).toThrow("outside");
    expect(() => scoped.registerProvider("anthropic")).toThrow("cannot change");
  });

  it("fails closed on unverified, oversized or incompatible native sources", async () => {
    const factory = await loadFactory();
    for (const source of ["export default {}", "x".repeat(2 * 1024 * 1024 + 1)])
      await expect(
        factory({
          root: "/fixture/runtime",
          config: {},
          env: { COX_OMO_MEMORY_HOME: "/fixture/memory" },
          readModule: async () => ({ source }),
        }),
      ).rejects.toThrow("verified");
    await expect(factory({ config: {}, env: { COX_OMO_MEMORY_HOME: "relative" } })).rejects.toThrow(
      "absolute",
    );
  });
});
