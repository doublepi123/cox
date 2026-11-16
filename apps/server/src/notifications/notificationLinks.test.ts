import { afterEach, expect, it, vi } from "vite-plus/test";

import { notificationBaseOrigin } from "./notificationLinks.ts";

afterEach(() => vi.unstubAllEnvs());
const config = { devUrl: undefined, host: undefined, port: 4773 };

it("prefers settings over the environment and development origin", () => {
  vi.stubEnv("COX_PUBLIC_BASE_URL", "https://environment.example.com");
  const development = { ...config, devUrl: new URL("http://localhost:5173") };
  expect(notificationBaseOrigin("https://settings.example.com", development)).toBe(
    "https://settings.example.com",
  );
  expect(notificationBaseOrigin(null, development)).toBe("https://environment.example.com");
  vi.stubEnv("COX_PUBLIC_BASE_URL", "https://invalid.example.com/subpath");
  expect(notificationBaseOrigin(null, development)).toBe("http://localhost:5173");
});

it.each([
  [undefined, "127.0.0.1"],
  ["0.0.0.0", "127.0.0.1"],
  ["::", "127.0.0.1"],
  ["[::]", "127.0.0.1"],
  ["192.0.2.10", "192.0.2.10"],
  ["::1", "[::1]"],
  ["[2001:db8::1]", "[2001:db8::1]"],
])("uses the bound or loopback authority for %s", (host, authority) => {
  vi.stubEnv("COX_PUBLIC_BASE_URL", "javascript:alert(1)");
  const origin = notificationBaseOrigin(null, { ...config, host });
  expect(new URL("/environment/thread", origin).toString()).toBe(
    `http://${authority}:4773/environment/thread`,
  );
});
