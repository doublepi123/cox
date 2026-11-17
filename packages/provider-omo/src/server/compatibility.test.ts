import { describe, expect, it } from "vite-plus/test";
import { OMO_MINIMUM_VERSION, isSupportedOmoVersion } from "./compatibility.ts";

describe("OMO version policy", () => {
  it("accepts the minimum version and any higher 5.1.x release", () => {
    expect(OMO_MINIMUM_VERSION).toBe("5.1.69");
    expect(isSupportedOmoVersion("5.1.69")).toBe(true);
    expect(isSupportedOmoVersion("5.1.75")).toBe(true);
    expect(isSupportedOmoVersion("5.2.0")).toBe(true);
    expect(isSupportedOmoVersion("5.1.68")).toBe(false);
    expect(isSupportedOmoVersion("4.9.0")).toBe(false);
  });
});
