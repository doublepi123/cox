import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import { makeProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import { withClaudeNativeRelease } from "./ClaudeMaintenance.ts";

const nativeCapabilities = makeProviderMaintenanceCapabilities({
  provider: ProviderDriverKind.make("claudeAgent"),
  packageName: "@anthropic-ai/claude-code",
  updateExecutable: "/home/test/.local/bin/claude",
  updateArgs: ["update"],
  updateLockKey: "claudeAgent-native",
});

it.effect.each([
  { channel: "stable", body: "2.1.19\n", latest: "2.1.19" },
  { channel: "latest", body: "invalid version", latest: null },
] as const)(
  "uses the Claude $channel release feed for native installs",
  ({ channel, body, latest }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(
        path.join(configDir, "settings.json"),
        JSON.stringify({ autoUpdatesChannel: channel }),
      );
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          expect(request.url).toBe(`https://downloads.claude.ai/claude-code-releases/${channel}`);
          return HttpClientResponse.fromWeb(request, new Response(body));
        }),
      );
      const maintenance = yield* withClaudeNativeRelease(nativeCapabilities).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {
          CLAUDE_CONFIG_DIR: configDir,
          PROGRAMFILES: configDir,
        }),
      );
      expect(maintenance.latestVersion).toBeNull();
      expect(maintenance.update).toBe(nativeCapabilities.update);
      const lookup = maintenance.lookupLatestVersion;
      expect(lookup).toBeDefined();
      if (!lookup) throw new Error("Missing native release lookup");
      expect(yield* lookup).toBe(latest);
    }).pipe(Effect.provide(NodeServices.layer)),
);
