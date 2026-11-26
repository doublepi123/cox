import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import { formatTraceSummary, makeTraceSpanSummary, traceCommand } from "./trace.ts";

const run = Command.runWith(traceCommand, { version: "0.0.0" });
const services = Layer.mergeAll(NodeServices.layer, TestConsole.layer);

const MINUTE_MS = 60_000;

function span(name: string, durationMs: number, endMs: number, exitTag = "Success") {
  return JSON.stringify({
    type: "effect-span",
    name,
    traceId: "trace",
    spanId: "span",
    durationMs,
    endTimeUnixNano: String(BigInt(endMs) * 1_000_000n),
    exit: { _tag: exitTag, cause: "cause" },
  });
}

function browserSpan(
  name: string,
  status: { code: string; message?: string },
  attributes: Record<string, unknown> = {},
) {
  return JSON.stringify({
    type: "otlp-span",
    name,
    durationMs: 1,
    endTimeUnixNano: "1000000",
    status,
    attributes,
  });
}

it("drops spans that ended before the window and counts unreadable lines", () => {
  const nowMs = Date.UTC(2026, 10, 24);
  const cutoff = BigInt(nowMs) * 1_000_000n - 1n;
  const summarizer = makeTraceSpanSummary({ nowMs, duration: Duration.nanos(1n) });
  [
    span("old", 1, 0),
    JSON.stringify({
      name: "just-before",
      durationMs: 1,
      endTimeUnixNano: String(cutoff - 1n),
    }),
    "",
    "{not json",
    JSON.stringify({ name: "no-duration" }),
    JSON.stringify({ name: "far-future", durationMs: 1, endTimeUnixNano: "9".repeat(22) }),
    JSON.stringify({ name: "at-cutoff", durationMs: 4, endTimeUnixNano: String(cutoff) }),
  ].forEach(summarizer.addLine);
  const summary = summarizer.finish();

  assert.strictEqual(summary.skippedLineCount, 3);
  assert.deepStrictEqual(
    summary.spans.map((entry) => [entry.name, entry.count, entry.perMinute]),
    [["at-cutoff", 1, undefined]],
  );
});

it("reads failures and interrupts of browser spans from their OTLP status", () => {
  const summarizer = makeTraceSpanSummary();
  [
    browserSpan("render", { code: "2", message: "boom" }),
    browserSpan("render", { code: "0" }, { "effect.fiber.interrupted": true }),
    browserSpan("render", { code: "1", message: "Interrupted" }),
    browserSpan("render", { code: "1" }),
  ].forEach(summarizer.addLine);

  const [render] = summarizer.finish().spans;
  assert.deepStrictEqual([render?.count, render?.interrupted, render?.failures], [4, 2, 1]);
});

it.effect("prints durations that round up to a second in seconds", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-trace-summary-" });
    const traceFile = `${baseDir}/userdata/logs/server.trace.ndjson`;
    yield* fs.makeDirectory(`${baseDir}/userdata/logs`, { recursive: true });
    yield* fs.writeFileString(
      traceFile,
      [span("rpc", 999.4, MINUTE_MS), span("rpc", 999.6, 2 * MINUTE_MS)].join("\n"),
    );

    yield* run(["summary", "--base-dir", baseDir]);

    const output = (yield* TestConsole.logLines).join("\n");
    const row = output.split("\n").find((line) => line.startsWith("rpc"));
    assert.deepStrictEqual(row?.trim().split(/\s+/).slice(3, 6), ["999ms", "1s", "1s"]);
  }).pipe(Effect.provide(services), Effect.scoped),
);

it.effect("prints exact dates while keeping sub-millisecond windows and rates", () =>
  Effect.gen(function* () {
    const lines = ["1795478399998000000", "1795478399998999950", "1795478399999999999"].map(
      (endTimeUnixNano) => JSON.stringify({ name: "rpc", durationMs: 1, endTimeUnixNano }),
    );
    const summarizer = makeTraceSpanSummary({
      nowMs: 1_795_478_400_000,
      duration: Duration.millis(1.75),
    });
    lines.forEach(summarizer.addLine);
    const summary = summarizer.finish();
    assert.strictEqual(summary.spanCount, 2);
    assert.strictEqual(summary.spans[0]?.perMinute?.toFixed(1), "120000.0");

    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-trace-boundary-" });
    yield* fs.makeDirectory(`${baseDir}/userdata/logs`, { recursive: true });
    yield* fs.writeFileString(`${baseDir}/userdata/logs/server.trace.ndjson`, lines.join("\n"));
    yield* run(["summary", "--base-dir", baseDir]);
    assert.include(
      (yield* TestConsole.logLines).join("\n"),
      "from 2026-11-23T23:59:59.998Z to 2026-11-23T23:59:59.999Z",
    );
  }).pipe(Effect.provide(services), Effect.scoped),
);

it("includes an end time in scientific notation at the window boundary", () => {
  const summarizer = makeTraceSpanSummary({ nowMs: 1_795_478_400_001, duration: Duration.zero });
  summarizer.addLine(
    JSON.stringify({ name: "rpc", durationMs: 1, endTimeUnixNano: "1795478400001e6" }),
  );
  assert.strictEqual(summarizer.finish().lastEndMs, 1_795_478_400_001);
});

it("formats large summaries without overflowing the call stack", () => {
  const rowCount = 150_000;
  const entry = {
    name: "long-span-name",
    count: 1,
    perMinute: 1,
    p50Ms: 1,
    p90Ms: 1,
    maxMs: 1,
    interrupted: 0,
    failures: 0,
  };
  const spans = Array.from({ length: rowCount }, () => entry);

  const lines = formatTraceSummary(
    {
      spanCount: rowCount,
      skippedLineCount: 0,
      firstEndMs: 0,
      lastEndMs: MINUTE_MS,
      minutes: 1,
      spans,
    },
    rowCount,
  ).split("\n");

  assert.strictEqual(lines.length, rowCount + 3);
  assert.strictEqual(lines[2], "span            count  /min  p50  p90  max  interrupted  failed");
  assert.strictEqual(
    lines.at(-1),
    "long-span-name      1   1.0  1ms  1ms  1ms            0       0",
  );
});
