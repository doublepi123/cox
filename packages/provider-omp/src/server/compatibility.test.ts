import { describe, expect, it } from "vite-plus/test";
import { OMP_MINIMUM_VERSION, isSupportedOmpVersion } from "./compatibility.ts";

describe("OMP version policy", () => {
  it("accepts the minimum version and later verified 18.x releases", () => {
    expect(OMP_MINIMUM_VERSION).toBe("18.20.2");
    expect(isSupportedOmpVersion("18.20.2")).toBe(true);
    expect(isSupportedOmpVersion("18.22.0")).toBe(true);
    expect(isSupportedOmpVersion("18.20.1")).toBe(false);
    expect(isSupportedOmpVersion("17.0.0")).toBe(false);
  });
});
