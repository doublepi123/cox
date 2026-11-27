import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@t3tools/provider-core/server/maintenanceResolver";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { CURSOR_CLI_DRIVER_KIND } from "./acpSupport.ts";
import { CursorCliDriver } from "./driver.ts";
import { CURSOR_CLI_INSTALL_SCRIPT_URL } from "./installation.ts";

const LATEST = "2026.11.22-e9042b2";
const INSTALLED = "2026.11.19-f005e9d";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        request.url === CURSOR_CLI_INSTALL_SCRIPT_URL
          ? Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  `DOWNLOAD_URL="https://downloads.cursor.com/lab/${LATEST}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"\n`,
                ),
              ),
            )
          : Effect.die(`Unexpected request to ${request.url}`),
      ),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Resolving Cursor CLI maintenance must not spawn a process"),
);

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("CursorCliDriver maintenance", (it) => {
  const installLayout = (versionsParent: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.realPath(
        yield* fs.makeTempDirectoryScoped({ prefix: "cox-cursor-cli-driver-" }),
      );
      const target = path.join(root, ...versionsParent, "versions", INSTALLED, "cursor-agent");
      const binaryPath = path.join(root, "bin", "cursor-agent");
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(target, "#!/bin/sh\n");
      yield* fs.chmod(target, 0o755);
      yield* fs.symlink(target, binaryPath);
      return yield* CursorCliDriver.create({
        instanceId: ProviderInstanceId.make("cursor-cli-maintenance"),
        displayName: "Cursor CLI test",
        enabled: false,
        environment: [],
        config: { ...CursorCliDriver.defaultConfig(), binaryPath },
      }).pipe(Effect.map((instance) => ({ instance, binaryPath })));
    });

  it.effect.skipIf(windowsHost)("updates an official installer copy with cursor-agent update", () =>
    Effect.gen(function* () {
      const { instance, binaryPath } = yield* installLayout([".local", "share", "cursor-agent"]);
      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toEqual(
        expect.objectContaining({ executable: binaryPath, args: ["update"] }),
      );
      const latestVersion = yield* resolveLatestProviderVersion(capabilities);
      expect(latestVersion).toBe(LATEST);
      expect(
        createProviderVersionAdvisory({
          driver: CURSOR_CLI_DRIVER_KIND,
          currentVersion: INSTALLED,
          latestVersion,
          maintenanceCapabilities: capabilities,
        }),
      ).toMatchObject({ status: "behind_latest", canUpdate: true });
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)("leaves a Cox-managed copy to the Cox installer", () =>
    Effect.gen(function* () {
      const { instance } = yield* installLayout(["tools", "cursor-cli"]);
      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toBeNull();
      expect(yield* resolveLatestProviderVersion(capabilities)).toBe(LATEST);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
