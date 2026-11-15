import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import {
  OMP_APPROVAL_MODE_ENV,
  OMP_EXTENSION_SOURCE,
  OMP_T3_MCP_EXTENSION_FILENAME,
  buildOmpLaunch,
  materializeOmpExtension,
  ompApprovalMode,
} from "./extension.ts";
import { PI_T3_MCP_EXTENSION_SOURCE } from "@t3tools/provider-pi/server";

describe("omp runtime mode mapping", () => {
  it("maps Cox runtime modes onto native approval modes", () => {
    expect(ompApprovalMode("approval-required")).toBe("always-ask");
    expect(ompApprovalMode("auto")).toBe("always-ask");
    expect(ompApprovalMode("auto-accept-edits")).toBe("write");
    expect(ompApprovalMode("full-access")).toBe("yolo");
  });
});

describe("buildOmpLaunch", () => {
  it("launches rpc-ui, strips Pi-injected flags and owns the approval mode", () => {
    const launch = buildOmpLaunch({
      launchArgs: ["--approve", "--skills", "review", "--approval-mode", "yolo", "--yolo"],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/cache/cox-omp-extension.ts",
      runtimeMode: "approval-required",
    });
    expect(launch.args).toEqual([
      "--mode",
      "rpc-ui",
      "--skills",
      "review",
      "--approval-mode",
      "always-ask",
      "--extension",
      "/cache/cox-omp-extension.ts",
    ]);
    expect(launch.env[OMP_APPROVAL_MODE_ENV]).toBe("always-ask");
  });

  it.each([
    ["auto", "always-ask"],
    ["auto-accept-edits", "write"],
    ["full-access", "yolo"],
  ] as const)("maps runtime mode %s to approval mode %s", (runtimeMode, approvalMode) => {
    const launch = buildOmpLaunch({
      launchArgs: [],
      environment: {},
      mcpSession: undefined,
      extensionPath: undefined,
      runtimeMode,
    });
    expect(launch.args).toEqual(["--mode", "rpc-ui", "--approval-mode", approvalMode]);
  });

  it("strips OMO permission presets copied into launch arguments", () => {
    const launch = buildOmpLaunch({
      launchArgs: ["--permission-preset", "full", "--permission-preset=ask", "--no-approve"],
      environment: {},
      mcpSession: undefined,
      extensionPath: undefined,
    });
    expect(launch.args).toEqual(["--mode", "rpc-ui"]);
  });

  it("maps session identity and short-lived probes", () => {
    expect(
      buildOmpLaunch({
        launchArgs: [],
        environment: {},
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        shortLived: true,
      }).args,
    ).toEqual(["--mode", "rpc-ui", "--no-session", "--offline"]);
    expect(
      buildOmpLaunch({
        launchArgs: [],
        environment: {},
        mcpSession: undefined,
        extensionPath: undefined,
        sessionPath: "/sessions/parent.jsonl",
      }).args,
    ).toEqual(["--mode", "rpc-ui", "--session", "/sessions/parent.jsonl"]);
  });

  it("disables extensions and tools after user arguments", () => {
    const launch = buildOmpLaunch({
      launchArgs: ["--extension", "/user/ext.ts", "--tools", "bash"],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/cache/cox-omp-extension.ts",
      disableExtensions: true,
      disableTools: true,
    });
    expect(launch.args).toEqual(["--mode", "rpc-ui", "--no-extensions", "--no-tools"]);
    expect(launch.env.T3_PI_MCP_EXTENSION_PATH).toBeUndefined();
  });

  it("passes scoped MCP credentials only while a session exists", () => {
    const environment = {
      T3_MCP_URL: "https://stale.example/mcp",
      T3_MCP_BEARER_TOKEN: "stale-token",
      T3_PI_RUNTIME_MODE: "full-access",
    };
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-omp-launch"),
      threadId: ThreadId.make("thread-omp-launch"),
      providerSessionId: "provider-session-omp-launch",
      providerInstanceId: ProviderInstanceId.make("omp"),
      endpoint: "https://cox.example/mcp",
      authorizationHeader: "Bearer scoped-token",
      browserToolsAvailable: true,
    };
    const withSession = buildOmpLaunch({
      launchArgs: [],
      environment,
      mcpSession,
      extensionPath: "/cache/cox-omp-extension.ts",
      runtimeMode: "approval-required",
    });
    expect(withSession.env).toMatchObject({
      T3_MCP_URL: "https://cox.example/mcp",
      T3_MCP_BEARER_TOKEN: "scoped-token",
      T3_PI_RUNTIME_MODE: "approval-required",
      T3_PI_MCP_EXTENSION_PATH: "/cache/cox-omp-extension.ts",
      [OMP_APPROVAL_MODE_ENV]: "always-ask",
    });
    const withoutSession = buildOmpLaunch({
      launchArgs: [],
      environment,
      mcpSession: undefined,
      extensionPath: undefined,
    });
    expect(withoutSession.env.T3_MCP_URL).toBeUndefined();
    expect(withoutSession.env.T3_MCP_BEARER_TOKEN).toBeUndefined();
    expect(withoutSession.env[OMP_APPROVAL_MODE_ENV]).toBeUndefined();
  });

  it("registers a user extension without duplicating the Cox extension", () => {
    const args = buildOmpLaunch({
      launchArgs: ["--extension", "/cache/cox-omp-extension.ts"],
      environment: {},
      mcpSession: undefined,
      extensionPath: "/cache/cox-omp-extension.ts",
    }).args;
    expect(args.filter((arg) => arg === "--extension")).toHaveLength(1);
  });
});

describe("OMP extension source", () => {
  it("reuses the materialized Pi MCP bridge instead of embedding an MCP client", () => {
    expect(OMP_EXTENSION_SOURCE).toContain('from "./pi-t3-mcp-extension.ts"');
    expect(OMP_EXTENSION_SOURCE).not.toContain("tools/list");
    expect(OMP_EXTENSION_SOURCE).not.toContain("jsonrpc");
  });

  it("adapts omp registration to native approval tiers and awaits active tool updates", () => {
    expect(OMP_EXTENSION_SOURCE).toContain('approval: READ_TOOLS.has(base) ? "read" : "exec"');
    expect(OMP_EXTENSION_SOURCE).toContain(
      'loadMode: READ_TOOLS.has(base) ? "essential" : "discoverable"',
    );
    expect(OMP_EXTENSION_SOURCE).toContain('mcpServerName: "cox"');
    expect(OMP_EXTENSION_SOURCE).toContain("target.setActiveTools(toolNames)");
    expect(OMP_EXTENSION_SOURCE).toContain("await settleToolUpdates()");
  });

  it("joins omp system prompt segments into the Pi string contract", () => {
    expect(OMP_EXTENSION_SOURCE).toContain('systemPrompt.join("\\n\\n")');
  });

  it("answers the bridge's native permission probe from the mapped approval mode", () => {
    expect(OMP_EXTENSION_SOURCE).toContain("getPermissionPreset");
    expect(OMP_EXTENSION_SOURCE).toContain('process.env[APPROVAL_ENV] ?? "yolo"');
  });

  it("does not use extension RPC surfaces omp does not implement", () => {
    expect(OMP_EXTENSION_SOURCE).not.toContain("pi.rpc");
    expect(OMP_EXTENSION_SOURCE).not.toContain("extension_request");
  });
});

effectIt.layer(NodeServices.layer)("materializeOmpExtension", (it) => {
  it.effect("writes the omp wrapper beside the reused Pi bridge", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = `${(yield* fs.makeTempDirectoryScoped().pipe(Effect.scoped)).replace(
        /\\/g,
        "/",
      )}/omp-extension-cache`;
      const extensionPath = yield* materializeOmpExtension(cacheDir);
      expect(extensionPath).toBe(`${cacheDir}/${OMP_T3_MCP_EXTENSION_FILENAME}`);
      const ompSource = yield* fs.readFileString(extensionPath);
      expect(ompSource).toBe(OMP_EXTENSION_SOURCE);
      const piSource = yield* fs.readFileString(`${cacheDir}/pi-t3-mcp-extension.ts`);
      expect(piSource).toBe(PI_T3_MCP_EXTENSION_SOURCE);
    }),
  );

  it.effect("leaves matching cached sources untouched", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = `${(yield* fs.makeTempDirectoryScoped().pipe(Effect.scoped)).replace(
        /\\/g,
        "/",
      )}/omp-extension-cache`;
      yield* fs.makeDirectory(cacheDir, { recursive: true });
      yield* fs.writeFileString(
        `${cacheDir}/${OMP_T3_MCP_EXTENSION_FILENAME}`,
        OMP_EXTENSION_SOURCE,
      );
      const statBefore = yield* fs.stat(`${cacheDir}/${OMP_T3_MCP_EXTENSION_FILENAME}`);
      yield* materializeOmpExtension(cacheDir);
      const statAfter = yield* fs.stat(`${cacheDir}/${OMP_T3_MCP_EXTENSION_FILENAME}`);
      expect(statAfter.mtime).toEqual(statBefore.mtime);
    }),
  );
});
