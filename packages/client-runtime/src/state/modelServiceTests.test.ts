import type { ModelServiceTestResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createModelServiceTestRunner } from "./modelServiceTests.ts";

const result = (id: string, ok = true): ModelServiceTestResult => ({
  modelId: id,
  revision: 1,
  ok,
  protocol: "openai-chat",
  durationMs: 10,
  message: ok ? null : "HTTP 404",
});

describe("model test batches", () => {
  it("limits concurrency and lets cancellation retain completed results without starting remaining requests", async () => {
    const runner = createModelServiceTestRunner();
    const pending = new Map<string, (value: ModelServiceTestResult) => void>();
    const batch = runner.run(
      ["first", "second", "third", "fourth"],
      1,
      (id) => new Promise((resolve) => pending.set(id, resolve)),
    );
    expect([...pending.keys()]).toEqual(["first", "second"]);
    pending.get("first")!(result("first", false));
    await Promise.resolve();
    expect([...pending.keys()]).toEqual(["first", "second", "third"]);
    runner.cancel();
    pending.get("second")!(result("second"));
    pending.get("third")!(result("third"));
    await batch;
    expect(runner.getSnapshot().results.size).toBe(1);
    expect(runner.getSnapshot().running).toBe(false);
    expect(pending.has("fourth")).toBe(false);
  });

  it("does not mark models as failed when the RPC or configuration becomes invalid", async () => {
    const runner = createModelServiceTestRunner();
    await runner.run(["first", "second", "third"], 1, async (id) => ({
      ...result(id),
      revision: 2,
    }));
    expect(runner.getSnapshot().results.size).toBe(0);
    expect(runner.getSnapshot().error).not.toBeNull();
    expect(runner.getSnapshot().running).toBe(false);
  });
});
