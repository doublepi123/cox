import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type { ProviderUsageReader } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makePiTranscriptUsageFormat } from "@t3tools/provider-pi/server/usage";
import type { OmoSettings } from "../settings.ts";

export const omoUsageFormat = makePiTranscriptUsageFormat("omo");

export function omoInstanceDirectory(baseDir: string, instanceId: string, path: Path.Path): string {
  return path.join(
    baseDir,
    "providers",
    "omo",
    instanceId === "." || instanceId === ".."
      ? instanceId.replaceAll(".", "%2E")
      : encodeURIComponent(instanceId),
  );
}

export const omoUsageReader: ProviderUsageReader<OmoSettings, Path.Path> = {
  kind: "transcripts",
  provider: "omo",
  format: omoUsageFormat,
  directories: Effect.fn("omoUsageReader.directories")(function* ({
    instanceId,
    config,
    baseDir,
    modelServiceAgentDir,
  }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const absolute = (value: string | undefined) => {
      const trimmed = value?.trim();
      if (!trimmed) return undefined;
      const expanded = expandHomePath(trimmed, home);
      return path.isAbsolute(expanded) ? path.resolve(expanded) : undefined;
    };
    const configuredAgentDir = absolute(config?.agentDir);
    const agentDir =
      configuredAgentDir ??
      (baseDir === undefined
        ? undefined
        : path.join(omoInstanceDirectory(baseDir, instanceId, path), "agent"));
    const sessionDir =
      absolute(config?.sessionDir) ??
      (agentDir === undefined ? undefined : path.join(agentDir, "sessions"));
    const agentDirs = [modelServiceAgentDir, agentDir].filter(
      (dir): dir is string => dir !== undefined,
    );
    const dirs = [
      ...(modelServiceAgentDir === undefined ? [] : [path.join(modelServiceAgentDir, "sessions")]),
      ...(sessionDir === undefined ? [] : [sessionDir]),
      ...agentDirs.map((dir) => path.join(dir, "tasks", "children")),
    ];
    return [...new Set(dirs)].map((dir) => ({ dir }));
  }),
};
