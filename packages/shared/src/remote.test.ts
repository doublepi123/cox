import { expect, it } from "vite-plus/test";
import {
  getPairingTokenFromUrl,
  setPairingTokenOnUrl,
  stripPairingTokenFromUrl,
} from "./remote.ts";
it("reads and strips local bootstrap tokens without changing the source URL", () => {
  const source = new URL("http://127.0.0.1:4773/pair?token=search#token=fragment&other=value");
  expect(getPairingTokenFromUrl(source)).toBe("fragment");
  expect(stripPairingTokenFromUrl(source).toString()).toBe(
    "http://127.0.0.1:4773/pair#other=value",
  );
  expect(getPairingTokenFromUrl(source)).toBe("fragment");
  expect(getPairingTokenFromUrl(setPairingTokenOnUrl(source, "new-token"))).toBe("new-token");
});
