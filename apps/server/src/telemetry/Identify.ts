import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as ServerConfig from "../config.ts";

export const TelemetryOwnerSource = Schema.Literal("device");
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read anonymous telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError;

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      filePath: error.filePath,
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (fileSystem: FileSystem.FileSystem, filePath: string) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new TelemetryIdentityReadError({
                filePath,
                cause,
              }),
            ),
    }),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* SecureRandom.SecureRandom.pipe(
    Effect.flatMap((crypto) => crypto.uuidV4()),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

/**
 * Identity is the hash of a random id persisted in the Cox state directory.
 * Null disables telemetry.
 */
export const getTelemetryIdentity = upsertAnonymousId.pipe(
  Effect.map(hashTelemetryId),
  Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(null))),
  Effect.map((installId) => ({ distinctId: installId, installId })),
  Effect.withSpan("getTelemetryIdentity"),
);
