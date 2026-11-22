// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { make as makeLocalServiceUpdate } from "./LocalServiceUpdate.ts";
import { supportsNpmCoxUpdates } from "./ownership.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

it.each([
  { managedBy: "CoCode", supported: false },
  { managedBy: undefined, supported: true },
])("matches host update ownership for $managedBy", async ({ managedBy, supported }) => {
  const directory = await mkdtemp(join(tmpdir(), "cox-managed-updates-"));
  directories.push(directory);
  const staticDir = join(directory, "dist", "client");
  const entry = join(directory, "dist", "bin.mjs");
  const executable = join(directory, "cox");
  await mkdir(staticDir, { recursive: true });
  await writeFile(entry, "");
  await writeFile(join(directory, "package.json"), '{"name":"@doublepi123/cox"}');
  await symlink(entry, executable);

  const previousArgv = [...process.argv];
  const previousSend = Object.getOwnPropertyDescriptor(process, "send");
  process.argv.splice(
    0,
    process.argv.length,
    ...previousArgv.slice(0, 1),
    executable,
    ...previousArgv.slice(2),
  );
  Object.defineProperty(process, "send", { configurable: true, value: undefined });
  vi.stubEnv("COX_UPDATES_MANAGED_BY", managedBy);
  try {
    expect(supportsNpmCoxUpdates({ devUrl: undefined, staticDir })).toBe(supported);
  } finally {
    process.argv.splice(0, process.argv.length, ...previousArgv);
    if (previousSend) Object.defineProperty(process, "send", previousSend);
    else Reflect.deleteProperty(process, "send");
  }
});

it.each([
  { managedBy: "CoCode", supported: false },
  { managedBy: undefined, supported: true },
])(
  "gates update state and capability for host ownership $managedBy",
  async ({ managedBy, supported }) => {
    const directory = await mkdtemp(join(tmpdir(), "cox-managed-updates-service-"));
    directories.push(directory);
    const staticDir = join(directory, "package", "dist", "client");
    const entry = join(directory, "package", "dist", "bin.mjs");
    const executable = join(directory, "cox");
    await mkdir(staticDir, { recursive: true });
    await writeFile(entry, "");
    await writeFile(join(directory, "package", "package.json"), '{"name":"@doublepi123/cox"}');
    await symlink(entry, executable);
    vi.stubEnv("COX_UPDATES_MANAGED_BY", managedBy);

    const configRuntime = ManagedRuntime.make(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), directory).pipe(
          Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodeServices.layer, NodeCrypto.layer)),
        ),
        NodeFileSystem.layer,
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    );
    const baseConfig = await configRuntime.runPromise(ServerConfig.ServerConfig);
    await configRuntime.dispose();
    const previousArgv = [...process.argv];
    const previousSend = Object.getOwnPropertyDescriptor(process, "send");
    process.argv.splice(
      0,
      process.argv.length,
      ...previousArgv.slice(0, 1),
      executable,
      ...previousArgv.slice(2),
    );
    Object.defineProperty(process, "send", { configurable: true, value: undefined });
    const runtimeDependencies = Layer.mergeAll(
      ServerConfig.layer({ ...baseConfig, staticDir }),
      NodeFileSystem.layer,
      NodeServices.layer,
      NodeCrypto.layer,
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        runtimeDependencies,
        ServerEnvironment.layer.pipe(Layer.provide(runtimeDependencies)),
      ),
    );
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const descriptor = await runtime.runPromise(
        Effect.gen(function* () {
          const environment = yield* ServerEnvironment.ServerEnvironment;
          return yield* environment.getDescriptor;
        }),
      );
      const service = await runtime.runPromise(makeLocalServiceUpdate());
      const state = await runtime.runPromise(supported ? service.state : service.check);

      expect(descriptor.capabilities.localServiceUpdate === true).toBe(supported);
      expect(state.supported).toBe(supported);
      if (supported) {
        expect(state).toMatchObject({ status: "idle", checkOnly: true });
      } else {
        expect(state).toMatchObject({ status: "unavailable", latestVersion: null });
        expect(fetch).not.toHaveBeenCalled();
      }
    } finally {
      fetch.mockRestore();
      await runtime.dispose();
      process.argv.splice(0, process.argv.length, ...previousArgv);
      if (previousSend) Object.defineProperty(process, "send", previousSend);
      else Reflect.deleteProperty(process, "send");
    }
  },
);
