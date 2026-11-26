import { describe, expect, it } from "vite-plus/test";
import { formatShortProcessName } from "./DiagnosticsSettings.logic";

describe("formatShortProcessName", () => {
  it("keeps a character whole when a long process name is cut", () => {
    const name = formatShortProcessName(`/fake/${"n".repeat(38)}😀tail-of-a-long-name`);
    expect(name).toBe(`${"n".repeat(38)}...`);
  });
});
