import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";

import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  acpRegistryProbeFailure,
  acpRegistryProbeResult,
  listAcpRegistrySessions,
  logoutAcpRegistry,
  makeAcpRegistryAdapterV2,
  normalizeAcpRegistryAuthMethods,
  normalizeAcpRegistryCommands,
  type AcpRegistryAvailableCommands,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { probeAcpRegistryConfiguration } from "../../../../packages/provider-acp-registry/src/server/probe.ts";

const instanceId = ProviderInstanceId.make("acpRegistry_codex");
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);

describe("ACP Registry probe", () => {
  it("returns advertised auth methods, de-duplicated models, and model option IDs", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          auth: { logout: {} },
          sessionCapabilities: { list: {}, resume: {} },
        },
        authMethods: [
          { id: "chatgpt", name: "ChatGPT" },
          {
            id: "api-key",
            name: "API key",
            type: "env_var",
            vars: [{ name: "OPENAI_API_KEY", label: "OpenAI API key" }],
          },
          { id: "login", name: "Terminal login", type: "terminal" },
        ],
      },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "gpt-5.4",
            options: [
              { value: "gpt-5.4", name: "GPT-5.4" },
              { value: "gpt-5.4", name: "Duplicate" },
            ],
          },
          {
            id: "effort",
            name: "Effort",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [{ value: "high", name: "High" }],
          },
          {
            id: "model-tool-use",
            name: "Tool use",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: "ask",
            options: [{ value: "ask", name: "Ask" }],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result).toEqual({
      instanceId,
      ready: true,
      icon: null,
      authMethods: [
        { id: "chatgpt", name: "ChatGPT", description: null, type: "agent" },
        {
          id: "api-key",
          name: "API key",
          description: null,
          type: "env_var",
          envVarNames: ["OPENAI_API_KEY"],
        },
        { id: "login", name: "Terminal login", description: null, type: "terminal" },
      ],
      models: [{ id: "gpt-5.4", name: "GPT-5.4", description: null }],
      currentModelId: "gpt-5.4",
      configOptions: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          role: "reasoning",
          currentValue: "high",
          options: [{ id: "high", label: "High" }],
        },
        { id: "model-tool-use", label: "Tool use", type: "boolean", currentValue: true },
        {
          id: "mode",
          label: "Mode",
          type: "select",
          currentValue: "ask",
          role: "mode",
          options: [{ id: "ask", label: "Ask" }],
        },
      ],
      modelOptionIds: ["effort", "model-tool-use"],
      sessionManagement: {
        canList: true,
        canLoad: true,
        canResume: true,
        canLogout: true,
        canDelete: false,
        canConfigureProviders: false,
      },
    });
  });

  it("composes runnable terminal auth commands from the resolved spawn recipe", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["auth", "log in"],
          env: { FORCE_TTY: "1" },
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods).toEqual([
      {
        id: "login",
        name: "Terminal login",
        description: null,
        type: "terminal",
        command: "FORCE_TTY=1 /opt/agents/devin --acp auth 'log in'",
      },
    ]);
  });

  it("omits unsafe truncated auth commands instead of publishing broken shell", () => {
    const methods = normalizeAcpRegistryAuthMethods(
      [
        {
          id: "login",
          name: "Terminal login",
          type: "terminal",
          args: ["x".repeat(2_048)],
        },
      ],
      { command: "/opt/agents/devin", args: ["--acp"] },
    );

    expect(methods[0]).not.toHaveProperty("command");
  });

  it("omits overlong opaque model ids instead of publishing mutated ids", () => {
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: "x".repeat(129),
            options: [
              { value: "x".repeat(129), name: "Too long" },
              { value: "valid", name: "Valid" },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([{ id: "valid", name: "Valid", description: null }]);
    expect(result.currentModelId).toBeNull();
  });

  it("preserves grouped model values and advertises reasoning choices", () => {
    const codexModel = '["codex","gpt-6.1-sol"]';
    const goModel = '["opencode-go","deepseek-v4.1-flash"]';
    const result = acpRegistryProbeResult(instanceId, {
      sessionId: "probe-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {
        sessionId: "probe-session",
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: goModel,
            options: [
              {
                groupId: "codex",
                name: "Codex",
                options: [{ value: codexModel, name: "GPT-6.1 Sol" }],
              },
              {
                groupId: "opencode-go",
                name: "OpenCode Go",
                options: [{ value: goModel, name: "DeepSeek V4.1 Flash" }],
              },
            ],
          },
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: "high",
            options: [
              {
                groupId: "effort",
                name: "Effort",
                options: [
                  { value: "medium", name: "Medium" },
                  { value: "high", name: "High" },
                ],
              },
            ],
          },
        ],
      },
      modelConfigId: "model",
    } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

    expect(result.models).toEqual([
      { id: codexModel, name: "GPT-6.1 Sol", description: null },
      { id: goModel, name: "DeepSeek V4.1 Flash", description: null },
    ]);
    expect(result.currentModelId).toBe(goModel);
    expect(result.configOptions).toEqual([
      {
        id: "reasoning",
        label: "Reasoning",
        type: "select",
        role: "reasoning",
        currentValue: "high",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ]);
  });

  it.each(["config option", "session model state"] as const)(
    "retains the current model beyond the catalog cap from %s",
    (source) => {
      const models = Array.from({ length: 257 }, (_, index) => ({
        modelId: `model-${index}`,
        name: `Model ${index}`,
      }));
      const result = acpRegistryProbeResult(instanceId, {
        sessionId: "probe-session",
        initializeResult: { protocolVersion: 1 },
        sessionSetupResult: {
          sessionId: "probe-session",
          ...(source === "config option"
            ? {
                configOptions: [
                  {
                    id: "model",
                    name: "Model",
                    category: "model",
                    type: "select",
                    currentValue: "model-256",
                    options: models.map(({ modelId, name }) => ({ value: modelId, name })),
                  },
                ],
              }
            : { models: { currentModelId: "model-256", availableModels: models } }),
        },
        modelConfigId: source === "config option" ? "model" : undefined,
      } satisfies AcpSessionRuntime.AcpSessionRuntimeStartResult);

      expect(result.models).toHaveLength(256);
      expect(result.models[0]?.id).toBe("model-0");
      expect(result.models.at(-1)?.id).toBe("model-256");
      expect(result.currentModelId).toBe("model-256");
    },
  );

  it("normalizes and de-duplicates advertised commands", () => {
    const commands = normalizeAcpRegistryCommands([
      {
        name: "create_plan",
        description: " Create a plan ",
        input: { type: "text", hint: " topic " },
      },
      { name: "CREATE_PLAN", description: "duplicate" },
      ...Array.from({ length: 127 }, (_, index) => ({
        name: `command_${index}`,
        description: "",
      })),
    ]);

    expect(commands.slashCommands).toHaveLength(128);
    expect(commands.slashCommands[0]).toEqual({
      name: "create_plan",
      description: "Create a plan",
      input: { hint: "topic" },
    });
    expect(
      commands.slashCommands.filter((command) => command.name.toLowerCase() === "create_plan"),
    ).toHaveLength(1);
    expect(commands.skills).toEqual([]);
  });

  it.live.each(["configuration probe", "live session update"] as const)(
    "keeps late slash commands and skills from a %s",
    (source) => {
      const slashCommands = Array.from({ length: 139 }, (_, index) => ({
        name: `command_${index}`,
      }));
      const advertised = [
        ...slashCommands.map(({ name }) => ({ name, description: "" })),
        { name: "COMMAND_0", description: "Duplicate" },
        { name: " invalid ", description: "Invalid command name" },
        { name: "$", description: "Invalid skill name" },
        { name: "$late-skill", description: "Late skill" },
      ];
      const agent = String.raw`
        import { createInterface } from "node:readline";
        const availableCommands = JSON.parse(process.argv[1]);
        const sessionId = "inventory-session";
        const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
        for await (const line of createInterface({ input: process.stdin })) {
          const { id, method } = JSON.parse(line);
          if (method === "initialize") {
            send({ id, result: { protocolVersion: 1, authMethods: [] } });
          } else if (method === "session/new") {
            send({ id, result: { sessionId } });
            send({ method: "session/update", params: {
              sessionId, update: { sessionUpdate: "available_commands_update", availableCommands },
            } });
          } else if (id !== undefined) {
            send({ id, error: { code: -32601, message: "Method not found" } });
          }
        }
      `;
      const catalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
        resolve: () =>
          Effect.succeed({
            distribution: "local",
            spawn: {
              command: process.execPath,
              args: ["--input-type=module", "-e", agent, JSON.stringify(advertised)],
              env: {},
            },
          }),
      });
      const input = {
        instanceId,
        settings: decodeSettings({ agentId: "inventory-fixture" }),
        cwd: process.cwd(),
        environment: {},
      };

      const commands =
        source === "configuration probe"
          ? probeAcpRegistryConfiguration(input)
          : Effect.gen(function* () {
              const coordinator =
                yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
              const published = yield* Deferred.make<AcpRegistryAvailableCommands>();
              yield* coordinator
                .watchAvailableCommands(instanceId, (update) =>
                  Deferred.succeed(published, update).pipe(Effect.asVoid),
                )
                .pipe(Effect.forkScoped);
              const adapter = yield* makeAcpRegistryAdapterV2({
                ...input,
                selfInvocation: yield* resolveSelfInvocation(),
              });
              const threadId = ThreadId.make("inventory-thread");
              const modelSelection = { instanceId, model: "default" };
              const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: input.cwd,
              });
              const runtime = yield* adapter.openSession({
                threadId,
                modelSelection,
                runtimePolicy,
                providerSessionId: ProviderSessionId.make("inventory-provider-session"),
              });
              yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
              return yield* Deferred.await(published).pipe(Effect.timeout("5 seconds"));
            });

      return Effect.gen(function* () {
        const result = yield* commands;
        expect({ slashCommands: result.slashCommands, skills: result.skills }).toEqual({
          slashCommands,
          skills: [
            {
              name: "late-skill",
              description: "Late skill",
              path: "acp://skill/late-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            catalog,
            Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
            AcpRegistryRuntimeCoordinator.layer,
            IdAllocator.layer,
            McpProviderSessions.layer,
            TestProviderHost.layer().pipe(
              Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
            ),
          ),
        ),
        Effect.scoped,
      );
    },
  );

  it("routes dollar-prefixed ACP commands to the provider skill menu", () => {
    expect(
      normalizeAcpRegistryCommands([
        { name: "$workspace-skill", description: "Run the workspace skill" },
        { name: "$WORKSPACE-SKILL", description: "duplicate" },
        { name: "$", description: "empty" },
        { name: "review", description: "Review changes" },
      ]),
    ).toEqual({
      slashCommands: [{ name: "review", description: "Review changes" }],
      skills: [
        {
          name: "workspace-skill",
          description: "Run the workspace skill",
          path: "acp://skill/workspace-skill",
          scope: "agent",
          enabled: true,
        },
      ],
    });
  });

  it.effect("lists native sessions and logs out through generic ACP lifecycle methods", () => {
    const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
      search: () => Effect.die("unused search"),
      prepare: () => Effect.die("unused prepare"),
      inspect: () => Effect.die("unused inspect"),
      uninstallManagedBinary: () => Effect.die("unused uninstall"),
      resolve: () =>
        Effect.succeed({
          agent: {
            id: "mock-agent",
            name: "Mock Agent",
            version: "1.0.0",
            description: "ACP session management test agent",
            distribution: { npx: { package: "mock-agent@1.0.0" } },
          },
          distribution: "npx" as const,
          spawn: {
            command: "node",
            args: [mockAgentPath],
            env: {
              ...process.env,
              T3_ACP_SESSION_LIFECYCLE: "1",
              T3_ACP_AUTH_METHOD_ID: "mock-login",
            },
          },
        }),
    });
    const input = {
      instanceId,
      settings: decodeSettings({ agentId: "mock-agent" }),
      cwd: process.cwd(),
      environment: process.env,
    };

    return Effect.gen(function* () {
      const listed = yield* listAcpRegistrySessions(input);
      expect(listed).toMatchObject({
        canLoad: true,
        canResume: true,
        nextCursor: null,
        sessions: [
          {
            sessionId: "mock-session-1",
            cwd: process.cwd(),
            importedThreadId: null,
          },
        ],
      });
      yield* logoutAcpRegistry(input);
    }).pipe(
      Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Effect.scoped,
    );
  });

  it.live("keeps DeepSeek Harness probe history in a temporary directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "acp-probe-dsh-" });
      const launcher = NodePath.join(directory, "dsh-fixture.mjs");
      const launchLog = NodePath.join(directory, "launch.json");
      yield* fs.writeFileString(
        launcher,
        `
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [,, agentPath, logPath, ...args] = process.argv;
const patchFlag = args.lastIndexOf("--patch");
const patchPath = patchFlag === -1 ? null : args[patchFlag + 1];
const patch = patchPath === null ? null : JSON.parse(readFileSync(patchPath, "utf8"));
writeFileSync(logPath, JSON.stringify({ args, patch }));
await import(pathToFileURL(agentPath).href);
`,
      );
      const userPatch = NodePath.join(directory, "user-patch.json");
      yield* fs.writeFileString(userPatch, "[]");
      const commandArgs = ["--profile", "acp", "--patch", userPatch];
      const catalog = AcpRegistrySupport.AcpRegistryCatalog.of({
        search: () => Effect.die("unused search"),
        prepare: () => Effect.die("unused prepare"),
        inspect: () => Effect.die("unused inspect"),
        uninstallManagedBinary: () => Effect.die("unused uninstall"),
        resolve: () =>
          Effect.succeed({
            distribution: "local",
            spawn: {
              command: process.execPath,
              args: [launcher, mockAgentPath, launchLog, ...commandArgs],
            },
          }),
      });
      const result = yield* probeAcpRegistryConfiguration({
        instanceId,
        settings: decodeSettings({ source: "local", commandPath: "dsh", commandArgs }),
        cwd: directory,
        environment: process.env,
      }).pipe(Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog));
      expect(result.probe.ready).toBe(true);
      expect(result.probe.models.length).toBeGreaterThan(0);

      const { args, patch } = JSON.parse(yield* fs.readFileString(launchLog));
      expect(args).toEqual([...commandArgs, "--patch", expect.any(String)]);
      const probeDirectory = NodePath.dirname(args.at(-1));
      expect(patch).toEqual([
        {
          id: "session-persistence-jsonl",
          config: { root: NodePath.join(probeDirectory, "sessions") },
        },
        { id: "session-projection-cache", disabled: true },
      ]);
      expect(yield* fs.exists(probeDirectory)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it("distinguishes authentication failures from generic probe failures", () => {
    const advertised = normalizeAcpRegistryAuthMethods([
      { id: "grok-login", name: "Log in with Grok" },
    ]);
    const cause = new EffectAcpErrors.AcpRequestError({
      code: -32000,
      errorMessage: "login required",
    });
    const authFailure = acpRegistryProbeFailure(cause, advertised);
    expect(authFailure.reason).toBe("authentication_failed");
    expect(authFailure.message).toBe("The ACP agent could not complete authentication.");
    expect(authFailure.cause).toBe(cause);
    expect(authFailure.authMethods).toEqual([
      {
        id: "grok-login",
        name: "Log in with Grok",
        description: null,
        type: "agent",
      },
    ]);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Authentication required",
          cause: "credentials missing",
        }),
      ).reason,
    ).toBe("authentication_failed");
    const genericCause = new EffectAcpErrors.AcpTransportError({
      detail: "connection closed",
      cause: "closed",
    });
    const genericFailure = acpRegistryProbeFailure(genericCause);
    expect(genericFailure.reason).toBe("probe_failed");
    expect(genericFailure.message).toBe("The ACP agent could not create a test session.");
    expect(genericFailure.cause).toBe(genericCause);
    expect(
      acpRegistryProbeFailure(
        new EffectAcpErrors.AcpTransportError({
          detail: "Failed while logging request",
          cause: "logging failed",
        }),
      ).reason,
    ).toBe("probe_failed");
  });
});
