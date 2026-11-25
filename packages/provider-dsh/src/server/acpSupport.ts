import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const DSH_DRIVER_KIND = ProviderDriverKind.make("dsh");
export const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
export const DSH_VERSION = "0.2.2-rc.5";
export const DSH_ACP_PLUS_PACKAGE_NAME = "dsh-acp-plus";
export const DSH_ACP_PLUS_COMMIT = "d595dae88948b14484c09a72eab71fcbf6fcb4e2";
export const DSH_ACP_PLUS_TARBALL = `https://codeload.github.com/AndPuQing/dsh-acp-plus/tar.gz/${DSH_ACP_PLUS_COMMIT}`;
export const DSH_OVERLAY_FILE = "cox-acp-plus.yml";
export const DSH_DEFAULT_MODEL = "deepseek-official/deepseek-flash";
export const DSH_DOCUMENTATION_URL = "https://github.com/deepseek-ai/deepseek-harness";

export const DSH_SUPPORTED_RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;

export function dshPermissionMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (runtimePolicy.approvalPolicy !== undefined || runtimePolicy.sandboxPolicy !== undefined) {
    return "read-only";
  }
  switch (runtimePolicy.runtimeMode) {
    case "full-access":
      return "danger-full-access";
    case "auto-accept-edits":
    case "auto":
      return "workspace-write";
    case "approval-required":
      return "read-only";
  }
}

export function dshAcpArgs(
  overlayPath: string,
  extraPatches: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  return [
    "--profile",
    "acp",
    "--patch",
    overlayPath,
    ...extraPatches.flatMap((patch) => ["--patch", patch]),
  ];
}

export function dshAcpPlusOverlay(bridgeUrl: string): string {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  return [
    "- id: acp",
    "  disabled: true",
    "- insert:",
    "    - id: workspace",
    "      name: '@deepseek-ai/dsh-workspace'",
    "    - id: acp-plus-startup",
    `      name: ${quote(`${bridgeUrl}/lib/app.js`)}`,
    "    - id: tool-ask-user",
    "      name: '@deepseek-ai/dsh-tool-ask-user'",
    "    - id: acp-plus",
    `      name: ${quote(`${bridgeUrl}/lib/index.js`)}`,
    "      inject: [acpPlusStartup]",
    "      config:",
    "        enableSessionLoad: true",
    "        enableAdditionalDirectories: true",
    "        enableSessionFork: true",
    "",
  ].join("\n");
}

export function dshEphemeralSessionsPatch(sessionsRoot: string): string {
  return JSON.stringify([
    { id: "session-persistence-jsonl", config: { root: sessionsRoot } },
    { id: "session-projection-cache", disabled: true },
  ]);
}

export function dshModelSlug(value: string): string {
  try {
    const route: unknown = JSON.parse(value);
    if (
      Array.isArray(route) &&
      route.length === 2 &&
      route.every((part) => typeof part === "string" && part.length > 0)
    )
      return `${route[0]}/${route[1]}`;
  } catch {}
  return value;
}

export function resolveDshModelValue(model: string | null | undefined): string | undefined {
  const slug = model?.trim();
  if (!slug) return undefined;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return slug;
  return JSON.stringify([slug.slice(0, separator), slug.slice(separator + 1)]);
}

export function dshProposedPlanMarkdown(toolCall: {
  readonly title?: string | null;
  readonly rawInput?: unknown;
}): string | undefined {
  if (toolCall.title !== "exit_plan_mode") return undefined;
  const input = toolCall.rawInput;
  if (typeof input !== "object" || input === null || !("plan" in input)) return undefined;
  const plan = input.plan;
  return typeof plan === "string" && plan.trim().length > 0 ? plan : undefined;
}

export interface DshRuntimeLaunch {
  readonly executablePath: string;
  readonly overlayPath: string;
}

export function dshRuntimeLaunch(input: {
  readonly baseDir: string;
  readonly platform: NodeJS.Platform;
  readonly join: (...segments: ReadonlyArray<string>) => string;
}): DshRuntimeLaunch & { readonly directory: string; readonly current: string } {
  const directory = input.join(input.baseDir, "tools", "dsh");
  const current = input.join(directory, "current");
  return {
    directory,
    current,
    executablePath: input.join(
      current,
      "node_modules",
      ".bin",
      input.platform === "win32" ? "dsh.cmd" : "dsh",
    ),
    overlayPath: input.join(current, DSH_OVERLAY_FILE),
  };
}

interface DshAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "spawn" | "clientCapabilities"
> {
  readonly launch: DshRuntimeLaunch;
  readonly environment: NodeJS.ProcessEnv;
  readonly extraPatches?: ReadonlyArray<string>;
  readonly clientCapabilities?: EffectAcpSchema.InitializeRequest["clientCapabilities"];
}

export const makeDshAcpRuntime = Effect.fn("makeDshAcpRuntime")(function* (
  input: DshAcpRuntimeInput,
): Effect.fn.Return<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
> {
  const { launch, environment, extraPatches, clientCapabilities, ...runtimeOptions } = input;
  const context = yield* Layer.build(
    AcpSessionRuntime.layer({
      ...runtimeOptions,
      spawn: {
        command: launch.executablePath,
        args: [...dshAcpArgs(launch.overlayPath, extraPatches)],
        cwd: input.cwd,
        env: { ...environment, NO_COLOR: "1" },
      },
      ...(clientCapabilities === undefined ? {} : { clientCapabilities }),
    }),
  );
  return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
});
