import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import type { SelectedFields } from "@t3tools/provider-core/server/usage";
import { ompUsageFormat, resolveOmpSessionsDir } from "./usage.ts";

const stateFactory = ompUsageFormat.state;
if (stateFactory === undefined) throw new Error("ompUsageFormat requires scan state");
const initialState = () => stateFactory.initial();

describe("ompUsageFormat", () => {
  it("attributes assistant usage to omp with the reported model", () => {
    const state = initialState();
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-omp-1" }), state);
    const records = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "m-1",
        timestamp: "2026-11-15T10:00:00.000Z",
        message: {
          provider: "anthropic",
          model: "claude-sonnet-4",
          responseModel: "claude-sonnet-4-20250514",
          role: "assistant",
          usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 5, reasoning: 12 },
        },
      }),
      state,
    );
    expect(records).toEqual([
      {
        provider: "omp",
        timestampMs: Date.parse("2026-11-15T10:00:00.000Z"),
        model: "anthropic/claude-sonnet-4-20250514",
        rateModel: "claude-sonnet-4-20250514",
        sessionId: "session-omp-1",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 10,
          cacheCreationTokens: 5,
          outputTokens: 40,
          reasoningTokens: 12,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "m-1",
          "2026-11-15T10:00:00.000Z",
          "anthropic/claude-sonnet-4-20250514",
        ]),
      },
    ]);
  });

  it("bills provider-reported costs and attributes tool records to Tools/summaries", () => {
    const state = initialState();
    const toolRecords = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "m-2",
        timestamp: "2026-11-15T10:01:00.000Z",
        message: { role: "toolResult", usage: { output: 7 } },
      }),
      state,
    );
    expect(toolRecords[0]).toMatchObject({
      provider: "omp",
      model: "Tools/summaries",
      totals: { outputTokens: 7 },
    });
    const usageRecords = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "usage",
        id: "u-1",
        timestamp: "2026-11-15T10:02:00.000Z",
        provider: "openai",
        model: "gpt-5",
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
      }),
      state,
    );
    expect(usageRecords[0]).toMatchObject({
      provider: "omp",
      model: "openai/gpt-5",
      reportedCostUsd: 0.01,
    });
  });

  it("skips unparsable lines, unknown entries and tokenless records", () => {
    const state = initialState();
    expect(ompUsageFormat.parseLine("not json", state)).toEqual([]);
    expect(ompUsageFormat.parseLine(JSON.stringify({ type: "other" }), state)).toEqual([]);
    expect(
      ompUsageFormat.parseLine(
        JSON.stringify({
          type: "usage",
          id: "u-2",
          timestamp: "2026-11-15T10:03:00.000Z",
          provider: "openai",
          model: "gpt-5",
          usage: {},
        }),
        state,
      ),
    ).toEqual([]);
  });

  it("attributes native assistant messages to the upstream model that served them", () => {
    const state = initialState();
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-omp-native" }), state);
    const records = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "m-native-1",
        parentId: null,
        timestamp: "2026-11-15T11:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "DONE" }],
          api: "openai-completions",
          provider: "openrouter",
          model: "openai/gpt-4o",
          upstreamProvider: "OpenAI",
          upstreamModel: "openai/gpt-4o-2024-11-20",
          usage: {
            input: 100,
            output: 40,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 155,
            reasoningTokens: 12,
            cost: {
              input: 0.0001,
              output: 0.0002,
              cacheRead: 0,
              cacheWrite: 0.0001,
              total: 0.0004,
            },
          },
          stopReason: "stop",
          timestamp: 1763204400000,
        },
      }),
      state,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "omp",
      timestampMs: Date.parse("2026-11-15T11:00:00.000Z"),
      model: "openrouter/openai/gpt-4o-2024-11-20",
      rateModel: "openai/gpt-4o-2024-11-20",
      sessionId: "session-omp-native",
      totals: {
        uncachedInputTokens: 100,
        cachedInputTokens: 10,
        cacheCreationTokens: 5,
        outputTokens: 40,
        reasoningTokens: 12,
      },
      reportedCostUsd: 0.0004,
    });
  });

  it("prefers an explicit responseModel over upstreamModel and the requested model", () => {
    const state = initialState();
    const records = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "message",
        id: "m-native-2",
        parentId: null,
        timestamp: "2026-11-15T11:00:01.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5",
          responseModel: "gpt-5-2026-01-01",
          upstreamModel: "gpt-5-serving-upstream",
          usage: { input: 10, output: 5, cost: { total: 0.002 } },
        },
      }),
      state,
    );
    expect(records[0]).toMatchObject({
      model: "openai/gpt-5-2026-01-01",
      rateModel: "gpt-5-2026-01-01",
    });
  });

  it("counts native model_usage background records with real token totals and cost", () => {
    const state = initialState();
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-omp-native" }), state);
    const records = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "model_usage",
        id: "mu-1",
        parentId: "m-native-1",
        timestamp: "2026-11-15T11:01:00.000Z",
        purpose: "title",
        role: "tiny",
        api: "openai-completions",
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        usage: {
          input: 60,
          output: 12,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 72,
          cost: { input: 0.00006, output: 0.000072, cacheRead: 0, cacheWrite: 0, total: 0.000132 },
        },
        stopReason: "stop",
      }),
      state,
    );
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      provider: "omp",
      timestampMs: Date.parse("2026-11-15T11:01:00.000Z"),
      model: "openrouter/openai/gpt-4o-mini",
      rateModel: "openai/gpt-4o-mini",
      sessionId: "session-omp-native",
      totals: {
        uncachedInputTokens: 60,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 12,
        reasoningTokens: 0,
      },
      reportedCostUsd: 0.000132,
      speed: "standard",
      dedupeKey: JSON.stringify([
        "omp",
        "mu-1",
        "2026-11-15T11:01:00.000Z",
        "openrouter/openai/gpt-4o-mini",
      ]),
    });
  });

  it("keeps the toolResult and compaction usage compatibility branches", () => {
    const state = initialState();
    ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-compat" }), state);
    const compactionRecords = ompUsageFormat.parseLine(
      JSON.stringify({
        type: "compaction",
        id: "c-1",
        parentId: null,
        timestamp: "2026-11-15T11:02:00.000Z",
        summary: "summarized",
        firstKeptEntryId: "m-1",
        tokensBefore: 1000,
        tokensAfter: 200,
        usage: { input: 800, output: 200 },
      }),
      state,
    );
    expect(compactionRecords).toHaveLength(1);
    expect(compactionRecords[0]).toMatchObject({
      model: "Tools/summaries",
      sessionId: "session-compat",
      totals: { uncachedInputTokens: 800, outputTokens: 200 },
    });
  });

  it("counts mixed legacy and native entries exactly once each", () => {
    const state = initialState();
    const lines = [
      { type: "session", id: "session-mixed" },
      {
        type: "message",
        id: "m-legacy",
        parentId: null,
        timestamp: "2026-11-15T12:00:00.000Z",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4",
          responseModel: "claude-sonnet-4-20250514",
          usage: { input: 100, output: 40, reasoning: 12 },
        },
      },
      {
        type: "message",
        id: "m-native",
        parentId: "m-legacy",
        timestamp: "2026-11-15T12:01:00.000Z",
        message: {
          role: "assistant",
          provider: "openai",
          model: "gpt-5",
          upstreamModel: "gpt-5-2026-01-01",
          usage: { input: 30, output: 20, reasoningTokens: 8, cost: { total: 0.001 } },
        },
      },
      {
        type: "model_usage",
        id: "mu-mixed",
        parentId: "m-native",
        timestamp: "2026-11-15T12:02:00.000Z",
        purpose: "compaction",
        api: "openai-completions",
        provider: "openai",
        model: "gpt-5-mini",
        usage: { input: 60, output: 12, cost: { total: 0.002 } },
        stopReason: "stop",
      },
      {
        type: "usage",
        id: "u-mixed",
        timestamp: "2026-11-15T12:03:00.000Z",
        provider: "openai",
        model: "gpt-5",
        usage: { input: 10, output: 5, cost: { total: 0.01 } },
      },
    ];
    const records = lines.flatMap((line) => ompUsageFormat.parseLine(JSON.stringify(line), state));
    expect(records).toHaveLength(4);
    expect(new Set(records.map((record) => record.dedupeKey)).size).toBe(4);
    expect(records.reduce((sum, record) => sum + record.totals.outputTokens, 0)).toBe(
      40 + 20 + 12 + 5,
    );
    expect(records.reduce((sum, record) => sum + record.totals.reasoningTokens, 0)).toBe(12 + 8);
    expect(records.map((record) => record.model)).toEqual([
      "anthropic/claude-sonnet-4-20250514",
      "openai/gpt-5-2026-01-01",
      "openai/gpt-5-mini",
      "openai/gpt-5",
    ]);
  });

  it("parses selectFields-projected native entries like full lines", () => {
    const projectSelected = (value: unknown, selected: true | SelectedFields): unknown => {
      if (selected === true || value === null || typeof value !== "object" || Array.isArray(value))
        return value;
      const projected: Record<string, unknown> = {};
      for (const [key, nested] of Object.entries(selected)) {
        if (key in value) projected[key] = projectSelected(Reflect.get(value, key), nested);
      }
      return projected;
    };
    const nativeEntries = [
      {
        type: "message",
        id: "m-proj",
        parentId: null,
        timestamp: "2026-11-15T13:00:00.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "large payload" }],
          provider: "openrouter",
          model: "openai/gpt-4o",
          upstreamProvider: "OpenAI",
          upstreamModel: "openai/gpt-4o-2024-11-20",
          usage: {
            input: 100,
            output: 40,
            cacheRead: 10,
            cacheWrite: 5,
            totalTokens: 155,
            reasoningTokens: 12,
            cost: { input: 0.0001, output: 0.0002, cacheRead: 0, cacheWrite: 0, total: 0.0003 },
          },
          stopReason: "stop",
        },
      },
      {
        type: "model_usage",
        id: "mu-proj",
        parentId: "m-proj",
        timestamp: "2026-11-15T13:01:00.000Z",
        purpose: "title",
        role: "tiny",
        api: "openai-completions",
        provider: "openrouter",
        model: "openai/gpt-4o-mini",
        usage: { input: 60, output: 12, totalTokens: 72, cost: { total: 0.000132 } },
        stopReason: "stop",
      },
    ];
    for (const entry of nativeEntries) {
      const lineState = initialState();
      ompUsageFormat.parseLine(JSON.stringify({ type: "session", id: "session-proj" }), lineState);
      const expected = ompUsageFormat.parseLine(JSON.stringify(entry), lineState);
      expect(expected).toHaveLength(1);
      const projectedState = initialState();
      ompUsageFormat.parseLine(
        JSON.stringify({ type: "session", id: "session-proj" }),
        projectedState,
      );
      const projected = projectSelected(entry, ompUsageFormat.selectFields);
      expect(ompUsageFormat.parseProjected(projected, projectedState)).toEqual(expected);
    }
  });
});

effectIt.layer(NodeServices.layer)("resolveOmpSessionsDir", (it) => {
  it.effect("prefers the scoped agent directory over every default", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(
        resolveOmpSessionsDir(
          { PI_CODING_AGENT_DIR: "/cox/omp/instance-1/agent", XDG_DATA_HOME: "/xdg-data" },
          "/home/user",
          path,
        ),
      ).toBe(path.resolve("/cox/omp/instance-1/agent/sessions"));
    }),
  );

  it.effect("follows the omp XDG redirect only without an agent directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(resolveOmpSessionsDir({ XDG_DATA_HOME: "/xdg-data" }, "/home/user", path)).toBe(
        path.resolve("/xdg-data/omp/sessions"),
      );
      expect(resolveOmpSessionsDir({}, "/home/user", path)).toBe(
        path.resolve("/home/user/.omp/agent/sessions"),
      );
    }),
  );
});
