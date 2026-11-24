import { expect, it } from "vite-plus/test";
import { deriveThreadTitleSeed } from "./threadTitle.ts";

it("keeps draft task titles from ending in half a character", () => {
  const prefix = "x".repeat(49);
  const emoji = "\u{1f600}";
  expect(deriveThreadTitleSeed({ text: prefix + emoji + " and more", attachments: [] })).toBe(
    prefix + "...",
  );
});
