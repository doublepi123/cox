import { describe, expect, it } from "@effect/vitest";
import { OmpFrameDecoder } from "./framing.ts";
import type { PiRpcRecord } from "@t3tools/provider-pi/server";

function chunks(value: PiRpcRecord): PiRpcRecord[] {
  const bytes = Buffer.from(JSON.stringify(value));
  const count = Math.ceil(bytes.length / (256 * 1024));
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "native-1",
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * 256 * 1024, (index + 1) * 256 * 1024).toString("base64"),
  }));
}

describe("OMP protocol v2 frames", () => {
  it("restores a large UTF-8 response without losing its request id", () => {
    const record = {
      type: "response",
      command: "get_messages",
      id: "t3-1",
      success: true,
      data: { text: "한글🙂".repeat(120_000) },
    };
    const decoder = new OmpFrameDecoder();
    const results = chunks(record).map((chunk) => decoder.push(chunk));
    expect(results.filter((result) => result !== undefined)).toEqual([record]);
  });

  it.each([
    { index: 1 },
    { count: 257 },
    { byteLength: 64 * 1024 * 1024 + 1 },
    { data: "AA=A" },
    { data: "AB==" },
  ])("rejects malformed native chunk metadata %j", (override) => {
    const decoder = new OmpFrameDecoder();
    expect(() =>
      decoder.push({
        type: "rpc_chunk",
        chunkId: "native",
        index: 0,
        count: 5,
        byteLength: 1024 * 1024,
        data: "YQ==",
        ...override,
      }),
    ).toThrow();
  });

  it("rejects interleaving and mismatched chunk owners", () => {
    const frames = chunks({ type: "message_end", text: "x".repeat(1024 * 1024) });
    const first = frames[0];
    const second = frames[1];
    if (first === undefined || second === undefined) throw new Error("fixture chunks missing");
    const interrupted = new OmpFrameDecoder();
    interrupted.push(first);
    expect(() => interrupted.push({ type: "agent_start" })).toThrow(/interrupted/);
    const mismatched = new OmpFrameDecoder();
    mismatched.push(first);
    expect(() => mismatched.push({ ...second, chunkId: "other" })).toThrow(/mismatch/);
  });
});
