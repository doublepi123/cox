import {
  parseGitRemoteHost,
  unknownRemoteProvider,
} from "@t3tools/source-control-core/shared/definition";
import {
  probeSourceControlProvider,
  refineUnknownRemoteProvider,
} from "@t3tools/source-control-core/server/discovery";
import { processOutput } from "@t3tools/source-control-testing/TestSourceControlHost";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { VcsProcessSpawnError } from "@t3tools/contracts";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/process";

import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const onPath = (command: string) => `/usr/bin/${command}`;

// Discovery sweeps every integration on a timer; a CLI that is not installed should cost one spawn.
it.effect("does not run the auth command when glab is not installed", () =>
  Effect.gen(function* () {
    const spawned: Array<string> = [];
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ operation, command, args, cwd }) => {
          spawned.push([command, ...args].join(" "));
          return Effect.fail(
            new VcsProcessSpawnError({
              operation,
              command,
              cwd,
              cause: PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcess",
                method: "spawn",
                pathOrDescriptor: command,
              }),
            }),
          );
        },
      },
    });
    assert.strictEqual(item.status, "missing");
    assert.deepStrictEqual(spawned, ["glab --version"]);
  }).pipe(Effect.provideService(SpawnExecutableResolution, onPath)),
);

it.effect("spawns nothing for a glab that is not on PATH", () =>
  Effect.gen(function* () {
    const spawned: Array<string> = [];
    const item = yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process: {
        run: ({ command, args }) => {
          spawned.push([command, ...args].join(" "));
          return Effect.succeed(processOutput("glab 1.124.0\n"));
        },
      },
    });
    assert.strictEqual(item.status, "missing");
    assert.strictEqual(item.auth.status, "unknown");
    assert.deepStrictEqual(spawned, []);
  }).pipe(Effect.provideService(SpawnExecutableResolution, () => undefined)),
);

it("reads the account from glab output without status marks", () => {
  const auth = GitLabSourceControlProvider.discovery.parseAuth(
    processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
  );
  assert.strictEqual(auth.status, "authenticated");
  assert.deepStrictEqual(auth.account, Option.some("gitlab-user"));
});

it.effect.each([
  {
    name: "without relying on host naming",
    remoteUrl: "https://self-hosted.example.test/group/project.git",
    host: "self-hosted.example.test",
    stdout: `gitlab.com
  x gitlab.com: API call failed: 401 Unauthorized
  ! No token found
self-hosted.example.test
  ✓ Logged in to self-hosted.example.test as gitlab-user
  ✓ Token found: ******
`,
    exitCode: 1,
  },
  {
    name: "on a non-standard port",
    remoteUrl: "https://self-hosted.example.test:8443/group/project.git",
    host: "self-hosted.example.test:8443",
    stdout: `self-hosted.example.test:8443
  ✓ Logged in to self-hosted.example.test:8443 as gitlab-user
  ✓ Token found: ******
`,
    exitCode: 0,
  },
] as const)("claims a self-hosted remote glab is signed in to $name", (scenario) =>
  Effect.gen(function* () {
    const remote = parseGitRemoteHost(scenario.remoteUrl);
    assert.ok(remote);
    const asked: Array<ReadonlyArray<string>> = [];
    const verdict = yield* refineUnknownRemoteProvider({
      specs: [GitLabSourceControlProvider.discovery],
      cwd: "/repo",
      context: {
        provider: unknownRemoteProvider(remote),
        remoteName: "origin",
        remoteUrl: scenario.remoteUrl,
      },
      process: {
        run: ({ command, args }) => {
          asked.push([command, ...args]);
          return Effect.succeed(
            processOutput(scenario.stdout, {
              exitCode: ChildProcessSpawner.ExitCode(scenario.exitCode),
            }),
          );
        },
      },
    });
    assert.deepStrictEqual(asked, [["glab", "auth", "status", "--hostname", scenario.host]]);
    assert.strictEqual(verdict.provider?.kind, "gitlab");
    assert.strictEqual(verdict.settled, true);
  }),
);

it.effect("sends the environment token only to glab's default host while probing", () =>
  Effect.gen(function* () {
    const withheld = { GITLAB_TOKEN: "", GITLAB_ACCESS_TOKEN: "", OAUTH_TOKEN: "" };
    const probes: Array<readonly [string, unknown]> = [];
    const process: Parameters<typeof probeSourceControlProvider>[0]["process"] = {
      run: ({ args, env }) => {
        if (args[0] !== "--version") probes.push([args.join(" "), env]);
        return Effect.succeed(
          processOutput("", {
            stderr: "No GitLab instances have been authenticated with glab.\n",
            exitCode: ChildProcessSpawner.ExitCode(1),
          }),
        );
      },
    };
    const remoteUrl = "https://self-hosted.example.test/group/project.git";
    const remote = parseGitRemoteHost(remoteUrl);
    assert.ok(remote);
    yield* probeSourceControlProvider({
      spec: GitLabSourceControlProvider.discovery,
      cwd: "/repo",
      process,
    });
    yield* refineUnknownRemoteProvider({
      specs: [GitLabSourceControlProvider.discovery],
      cwd: "/repo",
      context: { provider: unknownRemoteProvider(remote), remoteName: "origin", remoteUrl },
      process,
    });
    assert.deepStrictEqual(probes, [
      ["auth status", withheld],
      ["auth status --all", withheld],
      ["auth status --hostname gitlab.com", {}],
      ["auth status --hostname self-hosted.example.test", withheld],
    ]);
  }).pipe(
    Effect.provideService(HostProcess.Environment, { GITLAB_TOKEN: "default-host-token" }),
    Effect.provideService(SpawnExecutableResolution, onPath),
  ),
);
