import { describe, expect, it } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
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
