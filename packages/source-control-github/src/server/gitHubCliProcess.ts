import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const SESSION_ADDRESS_PREFIX = "DBUS_SESSION_BUS_ADDRESS=";

export const makeGhProcess = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer));
  const environment = yield* HostProcess.Environment;
  const platform = yield* HostProcess.Platform;
  const userId = yield* HostProcess.UserId;

  const fileExists = (path: string) =>
    fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
  const readText = (path: string) =>
    fileSystem.readFileString(path).pipe(Effect.orElseSucceed(() => ""));

  const noBusToDiscover = Effect.gen(function* () {
    if (platform === "darwin" || userId === undefined) return false;
    const runtimeDir = `/run/user/${userId}`;
    if (yield* fileExists(`${runtimeDir}/bus`)) return false;
    const session = yield* readText(`${runtimeDir}/dbus-session`);
    if (!session.startsWith(SESSION_ADDRESS_PREFIX)) return true;
    let end = session.length;
    while (
      end > SESSION_ADDRESS_PREFIX.length &&
      (session[end - 1] === "\n" || session[end - 1] === "\r")
    ) {
      end--;
    }
    return end === SESSION_ADDRESS_PREFIX.length;
  });

  return {
    run: (input) => {
      const address =
        input.env !== undefined && "DBUS_SESSION_BUS_ADDRESS" in input.env
          ? input.env.DBUS_SESSION_BUS_ADDRESS
          : environment.DBUS_SESSION_BUS_ADDRESS;
      if (address && address !== "autolaunch:") return process.run(input);
      return noBusToDiscover.pipe(
        Effect.flatMap((missing) =>
          process.run(
            missing
              ? { ...input, env: { ...input.env, DBUS_SESSION_BUS_ADDRESS: "disabled:" } }
              : input,
          ),
        ),
      );
    },
  } satisfies SourceControlHost.SourceControlHost["Service"]["process"];
});
