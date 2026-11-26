import { AcpRegistryListSessionsResult, AcpRegistryOperationError } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { makeDshAcpRuntime, type DshRuntimeLaunch } from "./acpSupport.ts";

const LIST_TIMEOUT = Duration.seconds(60);
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const decodeProjection = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      record: Schema.Struct({
        rows: Schema.Struct({
          title: Schema.optional(Schema.Struct({ val: Schema.NullOr(Schema.String) })),
        }),
      }),
    }),
  ),
);

export const dshHomeDirectory = Effect.fn("dshHomeDirectory")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDirectory =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
    (yield* HostProcess.HomeDirectory);
  return path.resolve(
    expandHomePath(environment.DSH_HOME?.trim() || path.join(homeDirectory, ".dsh"), homeDirectory),
  );
});

const readSessionProjection = Effect.fn("readDshSessionProjection")(function* (
  home: string,
  sessionId: string,
) {
  if (!SESSION_ID.test(sessionId)) return { title: null, updatedAt: null };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(home, "storages", "session_projcache", "sessions", `${sessionId}.json`);
  const [content, info] = yield* Effect.all([
    fs.readFileString(file).pipe(Effect.option),
    fs.stat(file).pipe(Effect.option),
  ]);
  const title = Option.flatMap(content, decodeProjection).pipe(
    Option.flatMap((projection) => Option.fromNullishOr(projection.record.rows.title?.val)),
    Option.map((value) => value.trim().slice(0, 1_024)),
    Option.filter((value) => value.length > 0),
    Option.getOrNull,
  );
  const updatedAt = info.pipe(
    Option.flatMap((stat) => stat.mtime),
    Option.map((date) => date.toISOString()),
    Option.getOrNull,
  );
  return { title, updatedAt };
});

export const listDshSessions = Effect.fn("listDshSessions")(
  function* (input: {
    readonly launch: DshRuntimeLaunch;
    readonly environment: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly cursor?: string;
  }) {
    const runtime = yield* makeDshAcpRuntime({
      launch: input.launch,
      environment: input.environment,
      cwd: input.cwd,
      clientInfo: { name: "cox-session-manager", version: "0.0.0" },
    });
    const initialized = yield* runtime.initialize();
    const listed = yield* runtime.listSessions(input.cursor);
    const home = yield* dshHomeDirectory(input.environment);
    const sessions = yield* Effect.forEach(
      listed.sessions
        .slice(0, 256)
        .filter((session) => session.sessionId.length > 0 && session.sessionId.length <= 1_024),
      (session) =>
        readSessionProjection(home, session.sessionId).pipe(
          Effect.map((projection) => ({
            sessionId: session.sessionId,
            cwd: session.cwd,
            additionalDirectories: (session.additionalDirectories ?? []).slice(0, 32),
            title: session.title?.trim().slice(0, 1_024) || projection.title,
            updatedAt: session.updatedAt?.trim().slice(0, 128) || projection.updatedAt,
            importedThreadId: null,
          })),
        ),
      { concurrency: 16 },
    );
    return AcpRegistryListSessionsResult.make({
      sessions,
      nextCursor: listed.nextCursor?.slice(0, 2_048) || null,
      canLoad: initialized.agentCapabilities?.loadSession === true,
      canResume: initialized.agentCapabilities?.sessionCapabilities?.resume != null,
      canDelete: false,
    });
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.timeoutOrElse({
        duration: LIST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new AcpRegistryOperationError({
              reason: "probe_failed",
              message: "DeepSeek Harness did not list its sessions in time.",
            }),
          ),
      }),
      Effect.mapError((cause) =>
        cause._tag === "AcpRegistryOperationError"
          ? cause
          : new AcpRegistryOperationError({
              reason: "probe_failed",
              message: "Could not list DeepSeek Harness sessions.",
              cause,
            }),
      ),
    ),
);
