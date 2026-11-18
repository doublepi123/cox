import { describe, expect, it } from "vite-plus/test";
import { PiRpcError, PiRpcTimeoutError } from "@t3tools/provider-pi/server";
import { omoProbeFailureMessage } from "./status.ts";

describe("OMO status probe failures", () => {
  it("keeps the startup detail reported by OMO Native", () => {
    expect(
      omoProbeFailureMessage(
        new PiRpcError({
          operation: "startup",
          detail: "The Cox OMO Native extension did not initialize. Native task: unregistered.",
        }),
      ),
    ).toBe(
      "Cox could not start OMO Native: The Cox OMO Native extension did not initialize. Native task: unregistered.",
    );
  });

  it("names the request that timed out", () => {
    const timeout = new PiRpcTimeoutError({ operation: "get_protocol_info", timeoutMs: 30_000 });
    const expected = "Cox could not start OMO Native: get_protocol_info timed out after 30000ms.";
    expect(omoProbeFailureMessage(timeout)).toBe(expected);
    expect(omoProbeFailureMessage(new PiRpcError({ operation: "startup", cause: timeout }))).toBe(
      expected,
    );
  });

  it("bounds long details and falls back when there is none", () => {
    expect(
      omoProbeFailureMessage(new PiRpcError({ operation: "startup", detail: "x".repeat(900) })),
    ).toHaveLength("Cox could not start OMO Native: .".length + 500);
    for (const error of [new PiRpcError({ operation: "startup" }), new Error("spawn ENOENT")])
      expect(omoProbeFailureMessage(error)).toBe(
        "Cox could not start OMO Native. Check the installation and model configuration.",
      );
  });
});
