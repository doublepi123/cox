import { expect, it } from "vite-plus/test";
import { stripSensitiveUrlToken } from "./remote.ts";

it("strips sensitive legacy URL tokens without reading credentials or changing the source", () => {
  const source = new URL(
    "http://127.0.0.1:4773/?token=search&other=query#token=fragment&other=value",
  );
  expect(stripSensitiveUrlToken(source).toString()).toBe(
    "http://127.0.0.1:4773/?other=query#other=value",
  );
  expect(source.searchParams.get("token")).toBe("search");
  expect(source.hash).toBe("#token=fragment&other=value");
});

it("preserves unrelated paths, query parameters and route hashes", () => {
  const source = new URL("http://localhost/project?theme=dark#/thread/123");
  expect(stripSensitiveUrlToken(source).toString()).toBe(source.toString());
});
