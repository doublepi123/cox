import { expect, it } from "@effect/vitest";
import { parseIgnoreFile } from "./IgnorePatterns.ts";

it("drops trailing spaces unless a backslash escapes them, like git", () => {
  expect(parseIgnoreFile("build  ").decide("build", false)).toBe("ignored");
  expect(parseIgnoreFile("keep\\ ").decide("keep ", false)).toBe("ignored");
  expect(parseIgnoreFile("dir\\\\ ").decide("dir\\", false)).toBe("ignored");
});
