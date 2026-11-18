import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { OmpSettings } from "../settings.ts";
import { ompEnvironment } from "./configuration.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoning: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = {
  provider: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  responseModel: Schema.optional(Schema.NonEmptyString),
  upstreamModel: Schema.optional(Schema.NonEmptyString),
  upstreamProvider: Schema.optional(Schema.NonEmptyString),
};
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Union([
      Schema.Struct({
        ...Model,
        role: Schema.Literal("assistant"),
        usage: Usage,
      }),
      Schema.Struct({ role: Schema.Literal("toolResult"), usage: Usage }),
    ]),
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("usage"), usage: Usage }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("model_usage"), usage: Usage }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literals(["compaction", "branch_summary"]),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

const parseOmpUsageRecord = (
  parsed: unknown,
  state: typeof OmpScanState.Type,
): readonly UsageRecord[] => {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  const rateModel =
    "model" in source ? (source.responseModel ?? source.upstreamModel ?? source.model) : undefined;
  const model =
    "provider" in source
      ? `${source.provider}/${source.provider === "cox" ? source.model : rateModel}`
      : "Tools/summaries";
  const outputTokens = tokenCount(usage.output);
  const totals = {
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens ?? usage.reasoning)),
  };
  const cost = usage.cost?.total;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      ...(rateModel === undefined ? {} : { rateModel }),
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
};

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    responseModel: true,
    upstreamModel: true,
    upstreamProvider: true,
    usage: true,
    message: {
      role: true,
      provider: true,
      model: true,
      responseModel: true,
      upstreamModel: true,
      upstreamProvider: true,
      usage: true,
    },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseOmpUsageRecord(parsed, state);
  },
  parseProjected: parseOmpUsageRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export function resolveOmpSessionsDir(
  environment: NodeJS.ProcessEnv,
  home: string,
  path: Path.Path,
): string {
  const agentDir = environment.PI_CODING_AGENT_DIR?.trim();
  if (agentDir) return path.resolve(path.join(expandHomePath(agentDir, home), "sessions"));
  const xdgData = environment.XDG_DATA_HOME?.trim();
  if (xdgData) return path.resolve(path.join(expandHomePath(xdgData, home), "omp", "sessions"));
  return path.resolve(path.join(home, ".omp", "agent", "sessions"));
}

function ompLaunchSessionDir(environment: NodeJS.ProcessEnv): string | undefined {
  return environment.PI_CODING_AGENT_SESSION_DIR?.trim() || undefined;
}

export const ompUsageReader: ProviderUsageReader<OmpSettings, Path.Path> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({
    environment,
    config,
    modelServiceAgentDir,
  }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const platform = yield* HostProcess.Platform;
    const launchHome = (platform === "win32" ? environment.USERPROFILE : environment.HOME) || home;
    const absolute = (value: string | undefined) => {
      const trimmed = value?.trim();
      return trimmed === undefined || trimmed === ""
        ? undefined
        : expandHomePath(trimmed, launchHome);
    };
    const launchDir = absolute(ompLaunchSessionDir(environment));
    const configuredDir = absolute(config?.sessionDir);
    return [
      ...(launchDir !== undefined && path.isAbsolute(launchDir)
        ? [{ dir: path.resolve(launchDir) }]
        : []),
      ...(configuredDir !== undefined && path.isAbsolute(configuredDir)
        ? [{ dir: path.resolve(configuredDir) }]
        : []),
      ...(modelServiceAgentDir === undefined
        ? []
        : [{ dir: path.join(modelServiceAgentDir, "sessions") }]),
      {
        dir: resolveOmpSessionsDir(
          config ? ompEnvironment(config, environment) : environment,
          home,
          path,
        ),
      },
    ];
  }),
};
