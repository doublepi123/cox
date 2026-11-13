import { it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";
import { OmoSettings } from "../settings.ts";
import { omoUsageFormat, omoUsageReader } from "./usage.ts";

const decodeSettings = Schema.decodeUnknownSync(OmoSettings);

it.effect.each([
  {
    name: "a model-service binding with an empty config",
    instanceId: "omo",
    config: {},
    modelServiceAgentDir: "/cox/model-services/runtime/omo/omo",
    expected: [
      "/cox/model-services/runtime/omo/omo/sessions",
      "/cox/providers/omo/omo/agent/sessions",
      "/cox/model-services/runtime/omo/omo/tasks/children",
      "/cox/providers/omo/omo/agent/tasks/children",
    ],
  },
  {
    name: "an unbound custom instance",
    instanceId: "omo_team",
    config: {},
    modelServiceAgentDir: undefined,
    expected: [
      "/cox/providers/omo/omo_team/agent/sessions",
      "/cox/providers/omo/omo_team/agent/tasks/children",
    ],
  },
  {
    name: "configured agent and session directories",
    instanceId: "omo_custom",
    config: { agentDir: "~/agent", sessionDir: "/history" },
    modelServiceAgentDir: undefined,
    expected: ["/history", "/home/user/agent/tasks/children"],
  },
] as const)(
  "reads OMO history for $name",
  ({ instanceId, config, modelServiceAgentDir, expected }) =>
    Effect.gen(function* () {
      if (omoUsageReader.kind !== "transcripts") throw new Error("Expected transcript usage");
      const directories = yield* omoUsageReader.directories({
        instanceId: ProviderInstanceId.make(instanceId),
        configured: true,
        config: decodeSettings(config),
        environment: {},
        baseDir: "/cox",
        ...(modelServiceAgentDir === undefined ? {} : { modelServiceAgentDir }),
      });
      expect(directories).toEqual(expected.map((dir) => ({ dir })));
    }).pipe(
      Effect.provide(Path.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/home/user"),
    ),
);

it("records OMO transcript usage under its own provider", () => {
  const state = omoUsageFormat.state!.initial();
  omoUsageFormat.parseLine(JSON.stringify({ type: "session", id: "root" }), state);
  const records = omoUsageFormat.parseLine(
    JSON.stringify({
      type: "message",
      id: "a1",
      timestamp: "2026-08-01T10:00:00Z",
      message: {
        role: "assistant",
        provider: "cox",
        model: "gpt-6.1-sol",
        usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 5, reasoning: 7 },
      },
    }),
    state,
  );
  expect(records.map(({ provider, model, sessionId }) => ({ provider, model, sessionId }))).toEqual(
    [{ provider: "omo", model: "cox/gpt-6.1-sol", sessionId: "root" }],
  );
});
