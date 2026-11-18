import { readFileSync } from "node:fs";

import { expect, it } from "vite-plus/test";

it("locks the page scale in the mobile viewport", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const match = html.match(/name="viewport"\s+content="([^"]+)"/);
  const content = match?.[1] ?? "";
  expect(content).toContain("width=device-width");
  expect(content).toContain("initial-scale=1");
  expect(content).toContain("minimum-scale=1");
  expect(content).toContain("maximum-scale=1");
  expect(content).toContain("viewport-fit=cover");
  expect(content).toContain("interactive-widget=resizes-content");
});
