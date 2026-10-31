import { expect, it } from "vite-plus/test";
import { environmentEndpointUrl } from "./endpoint.ts";
it("uses the local server origin and drops unrelated query credentials", () => {
  expect(
    environmentEndpointUrl("http://127.0.0.1:4773/path?token=secret#fragment", "/auth/session"),
  ).toBe("http://127.0.0.1:4773/auth/session");
});
