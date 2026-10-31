import { expect, it } from "@effect/vitest";
import { resolveHeadlessConnectionString } from "./startupAccess.ts";
it("formats loopback addresses for the local browser", () => {
  expect(resolveHeadlessConnectionString(undefined, 4773)).toBe("http://127.0.0.1:4773");
  expect(resolveHeadlessConnectionString("::1", 4773)).toBe("http://[::1]:4773");
});
