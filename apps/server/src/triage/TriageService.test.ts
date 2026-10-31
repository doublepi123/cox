import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import * as TriageService from "./TriageService.ts";
it.effect("prepares local diagnostics without a Git subprocess or source download", () =>
  Effect.gen(function* () {
    const service = yield* TriageService.TriageService;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const result = yield* service.prepare({ client: { label: "local browser" } });
    expect(result.prompt).toContain("triage");
    const sessions = yield* fs.readDirectory(path.join(config.stateDir, "triage"));
    expect(sessions).toHaveLength(1);
    expect(yield* fs.exists(path.join(config.baseDir, "source"))).toBe(false);
  }).pipe(
    Effect.provide(
      TriageService.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "cox-triage-" })),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
