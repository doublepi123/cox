import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { dshEphemeralSessionsPatch } from "./acpSupport.ts";

export const withDshEphemeralSessions = Effect.fn("withDshEphemeralSessions")(function* <A, E, R>(
  use: (patchPath: string) => Effect.Effect<A, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "cox-dsh-ephemeral-" });
  const patchPath = path.join(directory, "sessions.json");
  yield* fs.writeFileString(patchPath, dshEphemeralSessionsPatch(path.join(directory, "sessions")));
  return yield* use(patchPath);
});
