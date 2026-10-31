import { afterEach, expect, it, vi } from "vite-plus/test";
import { currentClientMetadata } from "./platform";
afterEach(() => vi.unstubAllGlobals());
it("identifies the local browser without a native bridge", () => {
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0", platform: "Linux", maxTouchPoints: 0 });
  expect(currentClientMetadata()).toMatchObject({ surface: "web" });
});
