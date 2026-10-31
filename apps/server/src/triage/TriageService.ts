import {
  ServerPrepareTriageError,
  type ServerPrepareTriageInput,
  type ServerPrepareTriageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import { buildTriageAppPrompt } from "./triagePrompt.ts";
import { writeTriageSession } from "./triageSession.ts";

export class TriageService extends Context.Service<
  TriageService,
  {
    readonly prepare: (
      input: ServerPrepareTriageInput,
    ) => Effect.Effect<ServerPrepareTriageResult, ServerPrepareTriageError>;
  }
>()("cox/triage/TriageService") {}

export const layer = Layer.effect(
  TriageService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const prepare: TriageService["Service"]["prepare"] = Effect.fn("TriageService.prepare")(
      function* (input) {
        const session = yield* writeTriageSession({
          baseDir: config.baseDir,
          paths: config,
          entry: { kind: "app", client: input.client.label ?? "local browser" },
          server: `running (pid ${process.pid}, version ${packageJson.version}); this session runs inside it`,
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => new ServerPrepareTriageError({ cause })),
        );
        return { prompt: buildTriageAppPrompt(session.promptFilePath) };
      },
    );
    return TriageService.of({ prepare });
  }),
);
