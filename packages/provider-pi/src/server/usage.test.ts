import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { PiSettings } from "../settings.ts";
import { piUsageReader } from "./usage.ts";

const decodeSettings = Schema.decodeUnknownSync(PiSettings);

it.effect.each([
  { launchArgs: '--session-dir="/launch sessions"', launchDir: "/launch sessions" },
  { launchArgs: "--session-dir ~/launch", launchDir: "/instance/launch" },
  { launchArgs: "--session-dir /old --session-dir /new", launchDir: "/new" },
  { launchArgs: '--system-prompt "--session-dir" --session-dir /actual', launchDir: "/actual" },
  { launchArgs: "--session-dir relative", launchDir: undefined },
  { launchArgs: "--session-dir /ignored --mode rpc", launchDir: undefined },
] as const)("keeps configured history alongside $launchArgs", ({ launchArgs, launchDir }) =>
  Effect.gen(function* () {
    if (piUsageReader.kind !== "transcripts") throw new Error("Expected transcript usage");
    const directories = yield* piUsageReader.directories({
      instanceId: ProviderInstanceId.make("pi_usage"),
      configured: true,
      config: decodeSettings({ launchArgs, agentDir: "~/configured" }),
      environment: { HOME: "/instance", PI_CODING_AGENT_DIR: "/inherited" },
    });
    expect(directories).toEqual([
      ...(launchDir === undefined ? [] : [{ dir: launchDir }]),
      { dir: "/host/configured/sessions" },
    ]);
  }).pipe(
    Effect.provide(Path.layer),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/host"),
  ),
);

it.effect("keeps explicit session history when a launch directory is configured", () =>
  Effect.gen(function* () {
    if (piUsageReader.kind !== "transcripts") throw new Error("Expected transcript usage");
    expect(
      yield* piUsageReader.directories({
        instanceId: ProviderInstanceId.make("pi_usage"),
        configured: true,
        config: decodeSettings({ launchArgs: "--session-dir /launch", agentDir: "/configured" }),
        environment: { PI_CODING_AGENT_SESSION_DIR: "/explicit" },
      }),
    ).toEqual([{ dir: "/launch" }, { dir: "/explicit" }]);
  }).pipe(Effect.provide(Path.layer)),
);
