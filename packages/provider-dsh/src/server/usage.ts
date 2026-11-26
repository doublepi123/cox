import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { DshSettings } from "../settings.ts";

const DshScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("assistant/message"),
    time: Schema.Number,
    data: Schema.Struct({
      message: Schema.Struct({
        id: Schema.NonEmptyString,
        source: Schema.Struct({ model: Schema.NonEmptyString }),
      }),
      usage: Schema.Struct({
        inputTokens: Schema.optional(Schema.Unknown),
        outputTokens: Schema.optional(Schema.Unknown),
        cacheReadTokens: Schema.optional(Schema.Unknown),
        cacheWriteTokens: Schema.optional(Schema.Unknown),
        reasoningTokens: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
]);
const decodeEvent = Schema.decodeUnknownOption(Event);

function parseEvent(parsed: unknown, state: typeof DshScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEvent(parsed);
  if (Option.isNone(decoded)) return [];
  const event = decoded.value;
  if (event.type === "session") {
    state.sessionId = event.id;
    return [];
  }
  const usage = event.data.usage;
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    uncachedInputTokens: tokenCount(usage.inputTokens),
    cachedInputTokens: tokenCount(usage.cacheReadTokens),
    cacheCreationTokens: tokenCount(usage.cacheWriteTokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  if (state.sessionId === "" || totalTokens(totals) === 0) return [];
  return [
    {
      provider: "dsh",
      timestampMs: event.time,
      model: event.data.message.source.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: `${state.sessionId}:${event.data.message.id}`,
    },
  ];
}

export const dshUsageFormat: TranscriptUsageFormat<typeof DshScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    time: true,
    data: { usage: true, message: { id: true, source: { model: true } } },
  },
  usageMarkers: ['"usage":', '"type":"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseEvent(parsed, state);
  },
  parseProjected: parseEvent,
  state: { initial: () => ({ sessionId: "" }), schema: DshScanState },
};

export const dshUsageDirectories = Effect.fn("dshUsageReader.directories")(function* ({
  environment,
}: {
  readonly environment: NodeJS.ProcessEnv;
}) {
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const homeDirectory =
    (platform === "win32" ? environment.USERPROFILE : environment.HOME) ||
    (yield* HostProcess.HomeDirectory);
  const home = expandHomePath(
    environment.DSH_HOME?.trim() || path.join(homeDirectory, ".dsh"),
    homeDirectory,
  );
  return [{ dir: path.resolve(home, "sessions") }];
});

export const dshUsageReader: ProviderUsageReader<DshSettings, Path.Path> = {
  kind: "transcripts",
  provider: "dsh",
  format: dshUsageFormat,
  directories: dshUsageDirectories,
};
