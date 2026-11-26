import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import { DshSettings } from "../settings.ts";
import {
  DSH_ACP_PLUS_TARBALL,
  DSH_VERSION,
  dshAcpArgs,
  dshAcpPlusOverlay,
  dshModelSlug,
  dshPermissionMode,
  dshSteeringInjected,
  dshProposedPlanMarkdown,
  resolveDshModelValue,
  withDshModelServicePatch,
} from "./acpSupport.ts";
import { extractDshElicitationForm } from "./elicitation.ts";
import { dshUsageDirectories } from "./usage.ts";
import { discoverDshSkills } from "./skills.ts";
import { listDshSessions } from "./sessions.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  dshRuntimeManifest,
  isSupportedDshVersion,
  makeDshInstallation,
  parseDshVersion,
} from "./installation.ts";
import {
  DSH_CREDENTIALS_MESSAGE,
  checkDshProviderStatus,
  dshModelsFromConfigOptions,
  dshSlashCommands,
} from "./status.ts";

const FAKE_DSH = fileURLToPath(new URL("./testing/fake-dsh.cjs", import.meta.url));
const settings = Schema.decodeSync(DshSettings)({ enabled: true });

describe("DeepSeek Harness launch", () => {
  it("boots the shipped acp profile with the bridge overlay before probe patches", () => {
    assert.deepStrictEqual(dshAcpArgs("/rt/cox-acp-plus.yml", ["/tmp/sessions.json"]), [
      "--profile",
      "acp",
      "--patch",
      "/rt/cox-acp-plus.yml",
      "--patch",
      "/tmp/sessions.json",
    ]);
  });

  it("replaces the native ACP row with dsh-acp-plus loaded from the managed runtime", () => {
    const overlay = parseYaml(dshAcpPlusOverlay("file:///rt/node_modules/dsh-acp-plus")) as Array<
      Record<string, unknown>
    >;
    assert.deepStrictEqual(overlay[0], { id: "acp", disabled: true });
    const inserted = overlay[1]!.insert as Array<Record<string, unknown>>;
    assert.deepStrictEqual(
      inserted.map((row) => [row.id, row.name]),
      [
        ["workspace", "@deepseek-ai/dsh-workspace"],
        ["acp-plus-startup", "file:///rt/node_modules/dsh-acp-plus/lib/app.js"],
        ["tool-ask-user", "@deepseek-ai/dsh-tool-ask-user"],
        ["acp-plus", "file:///rt/node_modules/dsh-acp-plus/lib/index.js"],
      ],
    );
    assert.deepStrictEqual(inserted[3]!.config, {
      enableSessionLoad: true,
      enableAdditionalDirectories: true,
      enableSessionFork: true,
    });
  });

  it("keeps quotes inside runtime paths literal", () => {
    const overlay = parseYaml(dshAcpPlusOverlay("file:///Users/o'neil/rt")) as Array<
      Record<string, unknown>
    >;
    const inserted = overlay[1]!.insert as Array<Record<string, unknown>>;
    assert.strictEqual(inserted[1]!.name, "file:///Users/o'neil/rt/lib/app.js");
  });

  it.each([
    ['["deepseek-official","deepseek-flash"]', "deepseek-official/deepseek-flash"],
    ['["openrouter","deepseek/deepseek-chat"]', "openrouter/deepseek/deepseek-chat"],
    ["plain-model", "plain-model"],
  ])("names route %s as model %s and sends it back unchanged", (value, slug) => {
    assert.strictEqual(dshModelSlug(value), slug);
    assert.strictEqual(resolveDshModelValue(slug), value.startsWith("[") ? value : slug);
  });

  it.each([
    ["approval-required", "read-only"],
    ["auto-accept-edits", "workspace-write"],
    ["full-access", "danger-full-access"],
  ] as const)("launches Cox mode %s with the dsh %s permission preset", (runtimeMode, preset) => {
    assert.strictEqual(
      dshPermissionMode(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode,
          interactionMode: "default",
          cwd: "/work",
        }),
      ),
      preset,
    );
  });

  it("asks for every change when an explicit approval policy overrides full access", () => {
    assert.strictEqual(
      dshPermissionMode(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/work",
          approvalPolicy: "on-request",
        }),
      ),
      "read-only",
    );
  });

  it("appends the bound model-service patch only when the instance has one", () => {
    const launch = { executablePath: "/rt/dsh", overlayPath: "/rt/cox-acp-plus.yml" };
    assert.deepStrictEqual(withDshModelServicePatch(launch, { modelServicePatch: "" }), launch);
    assert.deepStrictEqual(
      withDshModelServicePatch(launch, { modelServicePatch: "/ms/dsh/cox-models.yml" }),
      { ...launch, configPatches: ["/ms/dsh/cox-models.yml"] },
    );
  });

  it("leaves an unset model to the session default", () => {
    assert.strictEqual(resolveDshModelValue(undefined), undefined);
    assert.strictEqual(resolveDshModelValue("  "), undefined);
  });
});

describe("DeepSeek Harness steering", () => {
  it.each([
    [{ outcome: "injected" }, true],
    [{ outcome: "promptRequired", reason: "noRunningTurn" }, false],
    [null, false],
  ])("treats bridge response %j as injected=%s", (response, injected) => {
    assert.strictEqual(dshSteeringInjected(response), injected);
  });
});

describe("DeepSeek Harness plan review", () => {
  it("shows the plan dsh submits through exit_plan_mode", () => {
    assert.strictEqual(
      dshProposedPlanMarkdown({
        title: "exit_plan_mode",
        rawInput: { plan: "# Plan\n\n1. Add hello.txt" },
      }),
      "# Plan\n\n1. Add hello.txt",
    );
  });

  it.each([
    [{ title: "exit_plan_mode", rawInput: { plan: "  " } }],
    [{ title: "bash", rawInput: { plan: "# not a plan" } }],
    [{ title: "exit_plan_mode" }],
  ])("ignores tool call %#", (toolCall) => {
    assert.strictEqual(dshProposedPlanMarkdown(toolCall), undefined);
  });
});

describe("DeepSeek Harness questions", () => {
  const form = {
    sessionId: "s1",
    mode: "form",
    message: "Which greeting?",
    requestedSchema: {
      type: "object",
      properties: {
        greeting: {
          type: "string",
          title: "Greeting",
          description: "Which greeting should hello.txt contain?",
          oneOf: [
            { const: "hello", title: "hello", description: "English" },
            { const: "bonjour", title: "bonjour" },
          ],
        },
        greeting__other: {
          type: "string",
          title: "Other (optional)",
          description: "Free-text answer instead of the listed choices.",
        },
        langs: {
          type: "array",
          title: "Languages",
          items: { type: "string", enum: ["en", "fr"] },
        },
        langs__other: { type: "string", title: "Other (optional)" },
        note: { type: "string", title: "Note", description: "Anything else?" },
      },
    },
  } as const;

  it("folds each free-text companion into its question", () => {
    const parsed = extractDshElicitationForm(form);
    assert.deepStrictEqual(
      parsed?.questions.map((question) => [
        question.id,
        question.question,
        question.multiSelect === true,
        question.options.map((option) => option.value),
      ]),
      [
        ["greeting", "Which greeting should hello.txt contain?", false, ["hello", "bonjour"]],
        ["langs", "Languages", true, ["en", "fr"]],
        ["note", "Anything else?", false, []],
      ],
    );
  });

  it("returns chosen options as choices and anything else as the companion text", () => {
    const parsed = extractDshElicitationForm(form)!;
    assert.deepStrictEqual(
      parsed.respond({ greeting: "bonjour", langs: ["fr", "de"], note: "ok" }),
      {
        action: "accept",
        content: { greeting: "bonjour", langs: ["fr"], langs__other: "de", note: "ok" },
      },
    );
    assert.deepStrictEqual(parsed.respond({ greeting: "salut", langs: [] }), {
      action: "accept",
      content: { greeting__other: "salut", langs: [] },
    });
  });

  it("leaves forms from other agents to the generic parser", () => {
    assert.strictEqual(
      extractDshElicitationForm({
        ...form,
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "boolean", title: "Ok?" } },
        },
      }),
      undefined,
    );
    assert.strictEqual(
      extractDshElicitationForm({
        ...form,
        requestedSchema: {
          type: "object",
          properties: { stray__other: { type: "string", title: "x" } },
        },
      }),
      undefined,
    );
  });
});

describe("DeepSeek Harness session configuration", () => {
  const configOptions = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: '["deepseek-official","deepseek-flash"]',
      options: [
        {
          groupId: "deepseek-official",
          name: "DeepSeek",
          options: [
            { value: '["deepseek-official","deepseek-flash"]', name: "DeepSeek-V4.1-Flash" },
            { value: '["deepseek-official","deepseek-v4-pro"]', name: "DeepSeek-V4-Pro" },
          ],
        },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: "high",
      options: [
        { value: "off", name: "Off" },
        { value: "high", name: "High" },
      ],
    },
  ] as const;

  it("lists every model route with the session's reasoning effort choices", () => {
    const models = dshModelsFromConfigOptions(configOptions);
    assert.deepStrictEqual(
      models.map((model) => [model.slug, model.name, model.isDefault === true]),
      [
        ["deepseek-official/deepseek-flash", "DeepSeek-V4.1-Flash", true],
        ["deepseek-official/deepseek-v4-pro", "DeepSeek-V4-Pro", false],
      ],
    );
    const effort = models[0]!.capabilities?.optionDescriptors?.find(
      (option) => option.id === "reasoning_effort",
    );
    assert.deepStrictEqual(
      effort?.type === "select" ? effort.options.map((option) => option.id) : [],
      ["off", "high"],
    );
  });

  it("reports no models when the session offers no model route", () => {
    assert.deepStrictEqual(dshModelsFromConfigOptions([configOptions[1]]), []);
  });

  it("publishes each advertised command once with its input hint", () => {
    assert.deepStrictEqual(
      dshSlashCommands([
        {
          name: "plan",
          description: "Enter or leave plan mode",
          input: { type: "text", hint: "[off|message]" },
        },
        { name: "PLAN", description: "duplicate" },
        { name: "compact", description: "Compact older conversation history" },
      ]),
      [
        { name: "plan", description: "Enter or leave plan mode", input: { hint: "[off|message]" } },
        { name: "compact", description: "Compact older conversation history" },
      ],
    );
  });
});

describe("DeepSeek Harness version", () => {
  it.each([
    ["0.2.2-rc.5\n", "0.2.2-rc.5", true],
    ["dsh v0.2.2-rc.5", "0.2.2-rc.5", true],
    ["0.2.2-rc.4", "0.2.2-rc.4", false],
    ["0.2.2", "0.2.2", false],
    ["no version", null, false],
  ] as const)("reads %s as %s (supported=%s)", (output, version, supported) => {
    assert.strictEqual(parseDshVersion(output), version);
    assert.strictEqual(isSupportedDshVersion(version), supported);
  });
});

const makeInstallHarness = Effect.fn("DshInstallation.test.harness")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-dsh-install-test-" });
  const bin = path.join(root, "host-bin");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(bin, "npm"), "stub");
  yield* fs.chmod(path.join(bin, "npm"), 0o755);
  const installs: Array<{ readonly args: ReadonlyArray<string>; readonly manifest: string }> = [];
  let reportedVersion = DSH_VERSION;
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
      const args = command.args.map(String);
      if (args[0] === "install") {
        const staging = args[2]!;
        installs.push({
          args,
          manifest: yield* fs.readFileString(path.join(staging, "package.json")),
        });
        yield* fs.makeDirectory(path.join(staging, "node_modules", ".bin"), { recursive: true });
        yield* fs.makeDirectory(path.join(staging, "node_modules", "dsh-acp-plus", "lib"), {
          recursive: true,
        });
        yield* fs.writeFileString(path.join(staging, "node_modules", ".bin", "dsh"), "dsh");
      }
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout:
          args[0] === "--version"
            ? Stream.encodeText(Stream.make(`${reportedVersion}\n`))
            : Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  let refreshed = 0;
  const versionsSeenOnRefresh: Array<string | null> = [];
  const refreshDone = yield* Deferred.make<void>();
  const readInstalledVersion: { current: Effect.Effect<string | null> } = {
    current: Effect.succeed(null),
  };
  const installation = yield* makeDshInstallation({
    instanceId: ProviderInstanceId.make("dsh-test"),
    baseDir: root,
    environment: { PATH: bin },
    onChanged: Effect.suspend(() => {
      refreshed++;
      return readInstalledVersion.current.pipe(
        Effect.map((version) => {
          versionsSeenOnRefresh.push(version);
        }),
        Effect.andThen(Deferred.succeed(refreshDone, undefined)),
        Effect.asVoid,
      );
    }),
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  readInstalledVersion.current = installation.installedVersion;
  const terminal = Effect.suspend(() =>
    installation.changes.pipe(
      Stream.filter((state) => ["succeeded", "failed", "cancelled"].includes(state.phase)),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    ),
  );
  return {
    root,
    installation,
    terminal,
    installs,
    refreshed: () => refreshed,
    versionsSeenOnRefresh,
    refreshDone,
    report: (version: string) => {
      reportedVersion = version;
    },
  };
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "DeepSeek Harness installation",
  (it) => {
    it.effect("installs the pinned runtime and bridge, then switches the launch to it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const h = yield* makeInstallHarness();
        yield* h.installation.start;
        const state = yield* h.terminal;
        assert.strictEqual(state.phase, "succeeded", state.message ?? undefined);
        assert.strictEqual(state.installedVersion, DSH_VERSION);
        yield* Deferred.await(h.refreshDone);
        assert.deepStrictEqual(h.versionsSeenOnRefresh, [DSH_VERSION]);
        const manifest = JSON.parse(h.installs[0]!.manifest) as {
          dependencies: Record<string, string>;
        };
        assert.deepStrictEqual(manifest.dependencies, {
          "@deepseek-ai/dsh": DSH_VERSION,
          "dsh-acp-plus": DSH_ACP_PLUS_TARBALL,
        });
        assert.strictEqual(h.installs[0]!.manifest, dshRuntimeManifest());
        const release = yield* fs.realPath(path.join(h.root, "tools", "dsh", "current"));
        assert.strictEqual(path.dirname(release), path.join(h.root, "tools", "dsh", "releases"));
        assert.isTrue(yield* fs.exists(h.installation.launch.executablePath));
        const overlay = parseYaml(
          yield* fs.readFileString(h.installation.launch.overlayPath),
        ) as Array<Record<string, unknown>>;
        const bridge = (overlay[1]!.insert as Array<Record<string, unknown>>)[3]!.name as string;
        assert.strictEqual(
          fileURLToPath(bridge),
          path.join(release, "node_modules", "dsh-acp-plus", "lib", "index.js"),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("keeps only the active release after an update", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const h = yield* makeInstallHarness();
        yield* h.installation.start;
        yield* h.terminal;
        const first = yield* fs.realPath(path.join(h.root, "tools", "dsh", "current"));
        yield* h.installation.start;
        assert.strictEqual((yield* h.terminal).phase, "succeeded");
        const second = yield* fs.realPath(path.join(h.root, "tools", "dsh", "current"));
        assert.notStrictEqual(second, first);
        assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(second)), [
          path.basename(second),
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a runtime that reports another version and keeps the current launch", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const h = yield* makeInstallHarness();
        h.report("0.2.1");
        yield* h.installation.start;
        const state = yield* h.terminal;
        assert.strictEqual(state.phase, "failed");
        assert.include(state.message ?? "", "unexpected version");
        assert.isFalse(yield* fs.exists(h.installation.launch.executablePath));
        assert.strictEqual(h.refreshed(), 0);
      }).pipe(Effect.scoped),
    );
  },
);

const statusWith = (
  environment: NodeJS.ProcessEnv,
  version: string | null = DSH_VERSION,
  configPatches?: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-dsh-status-test-" });
    const log = path.join(root, "calls.log");
    yield* fs.chmod(FAKE_DSH, 0o755);
    const draft = yield* checkDshProviderStatus({
      settings,
      environment: { ...process.env, ...environment, FAKE_DSH_LOG: log },
      cwd: root,
      launch: {
        executablePath: FAKE_DSH,
        overlayPath: path.join(root, "overlay.yml"),
        ...(configPatches === undefined ? {} : { configPatches }),
      },
      version: Effect.succeed(version),
    });
    const calls = (yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ReadonlyArray<string>);
    return { draft, calls, overlayPath: path.join(root, "overlay.yml") };
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DeepSeek Harness status", (it) => {
  it.effect("reports ready with models and commands from an isolated probe session", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { draft, calls, overlayPath } = yield* statusWith({});
      assert.strictEqual(draft.status, "ready");
      assert.strictEqual(draft.version, DSH_VERSION);
      assert.strictEqual(draft.auth.status, "unknown");
      assert.deepStrictEqual(
        draft.models.map((model) => model.slug),
        ["deepseek-official/deepseek-flash", "deepseek-official/deepseek-v4-pro"],
      );
      assert.deepStrictEqual(
        draft.slashCommands.map((command) => command.name),
        ["plan", "compact"],
      );
      const args = calls[0]!;
      assert.deepStrictEqual(args.slice(0, 4), ["--profile", "acp", "--patch", overlayPath]);
      assert.strictEqual(args[4], "--patch");
      assert.isFalse(yield* fs.exists(args[5]!));
      assert.deepStrictEqual(draft.nativeSessions, {
        canList: true,
        canLoad: true,
        canResume: false,
        canDelete: false,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports an API key from the provider environment as the credential", () =>
    Effect.gen(function* () {
      const { draft } = yield* statusWith({ DEEPSEEK_API_KEY: "sk-test" });
      assert.deepStrictEqual(draft.auth, {
        status: "authenticated",
        type: "apiKey",
        label: "DeepSeek API key",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("probes with the model-service patch and reports the bound service", () =>
    Effect.gen(function* () {
      const { draft, calls, overlayPath } = yield* statusWith({}, DSH_VERSION, [
        "/runtime/dsh/cox-models.yml",
      ]);
      assert.deepStrictEqual(calls[0]!.slice(0, 6), [
        "--profile",
        "acp",
        "--patch",
        overlayPath,
        "--patch",
        "/runtime/dsh/cox-models.yml",
      ]);
      assert.strictEqual(calls[0]![6], "--patch");
      assert.deepStrictEqual(draft.auth, {
        status: "authenticated",
        type: "modelService",
        label: "Cox model service",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("asks for credentials when no model route is usable", () =>
    Effect.gen(function* () {
      const { draft } = yield* statusWith({ FAKE_DSH_MODELS: "none" });
      assert.strictEqual(draft.status, "error");
      assert.strictEqual(draft.auth.status, "unauthenticated");
      assert.strictEqual(draft.message, DSH_CREDENTIALS_MESSAGE);
      assert.deepStrictEqual(
        draft.slashCommands.map((command) => command.name),
        ["plan", "compact"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("does not start the runtime before it is installed", () =>
    Effect.gen(function* () {
      const { draft, calls } = yield* statusWith({}, null);
      assert.strictEqual(draft.installed, false);
      assert.strictEqual(draft.status, "error");
      assert.deepStrictEqual(calls, []);
    }).pipe(Effect.scoped),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DeepSeek Harness usage", (it) => {
  it.effect("reads sessions from the harness home the instance launches with", () =>
    Effect.gen(function* () {
      const directories = (environment: NodeJS.ProcessEnv) => dshUsageDirectories({ environment });
      assert.deepStrictEqual(yield* directories({ HOME: "/home/user" }), [
        { dir: "/home/user/.dsh/sessions" },
      ]);
      assert.deepStrictEqual(yield* directories({ HOME: "/home/user", DSH_HOME: "~/work-dsh" }), [
        { dir: "/home/user/work-dsh/sessions" },
      ]);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );
});

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "DeepSeek Harness sessions",
  (it) => {
    it.effect("lists the project's native sessions with titles from the harness projection", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-dsh-sessions-test-" });
        const home = path.join(root, "dsh");
        const projections = path.join(home, "storages", "session_projcache", "sessions");
        yield* fs.makeDirectory(projections, { recursive: true });
        yield* fs.writeFileString(
          path.join(projections, "titled.json"),
          JSON.stringify({
            version: 7,
            record: { rows: { title: { val: "  Fix the parser  " } } },
          }),
        );
        yield* fs.writeFileString(path.join(projections, "broken.json"), "{");
        yield* fs.chmod(FAKE_DSH, 0o755);
        const listed = yield* listDshSessions({
          launch: { executablePath: FAKE_DSH, overlayPath: path.join(root, "overlay.yml") },
          environment: {
            ...process.env,
            DSH_HOME: home,
            FAKE_DSH_LOG: path.join(root, "calls.log"),
            FAKE_DSH_SESSIONS: JSON.stringify([
              { sessionId: "titled", cwd: root },
              { sessionId: "broken", cwd: root },
              { sessionId: "untracked", cwd: root, title: "Agent title" },
              { sessionId: "elsewhere", cwd: path.join(root, "other") },
            ]),
          },
          cwd: root,
        });
        assert.deepStrictEqual(
          listed.sessions.map((session) => [session.sessionId, session.title]),
          [
            ["titled", "Fix the parser"],
            ["broken", null],
            ["untracked", "Agent title"],
          ],
        );
        assert.isString(listed.sessions[0]!.updatedAt);
        assert.isNull(listed.sessions[2]!.updatedAt);
        assert.deepInclude(listed, { canLoad: true, canResume: false, canDelete: false });
      }).pipe(Effect.scoped),
    );
  },
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("DeepSeek Harness skills", (it) => {
  it.effect("lists skills from the harness project and user roots in priority order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "cox-dsh-skills-test-" });
      const project = path.join(root, "repo");
      const home = path.join(root, "home");
      const write = (file: string, name: string, description: string, extra = "") =>
        Effect.gen(function* () {
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(
            file,
            `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody\n`,
          );
        });
      yield* fs.makeDirectory(path.join(project, ".git"), { recursive: true });
      yield* write(path.join(project, ".dsh/skills/greet/SKILL.md"), "greet", "Project greet");
      yield* write(path.join(project, ".agents/skills/review.md"), "review", "Shared review");
      yield* write(
        path.join(project, ".agents/skills/greet/SKILL.md"),
        "greet",
        "Shadowed by the dsh root",
      );
      yield* write(
        path.join(project, ".dsh/skills/nested/deeper/SKILL.md"),
        "deeper",
        "Nested skills are not discovered",
      );
      yield* write(
        path.join(home, "dsh/skills/deploy/SKILL.md"),
        "deploy",
        "User deploy",
        "disable-model-invocation: true\n",
      );
      yield* write(path.join(home, "dsh/skills/.system/hidden/SKILL.md"), "hidden", "System");
      yield* write(
        path.join(home, ".agents/skills/quiet.md"),
        "quiet",
        "Model only",
        "user-invocable: false\n",
      );
      yield* fs.writeFileString(path.join(project, ".dsh/skills/broken.md"), "no frontmatter");

      const skills = yield* discoverDshSkills(
        path.join(project, "packages", "app"),
        { DSH_HOME: path.join(home, "dsh") },
        home,
      );
      assert.deepStrictEqual(
        skills.map((skill) => [skill.name, skill.description, skill.scope]),
        [
          ["deploy", "User deploy", "user"],
          ["greet", "Project greet", "project"],
          ["quiet", "Model only", "user"],
          ["review", "Shared review", "project"],
        ],
      );
      assert.strictEqual(skills.find((skill) => skill.name === "deploy")?.userInvocationOnly, true);
      assert.strictEqual(skills.find((skill) => skill.name === "quiet")?.userInvocable, false);
    }).pipe(Effect.scoped),
  );
});
