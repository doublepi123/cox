import { describe, expect, it } from "vite-plus/test";

import { webhookAddress } from "./webhookAddress.ts";

const endpoint = {
  path: "/hooks/abc",
  url: null,
  hasSecret: true,
};

describe("webhookAddress", () => {
  it("builds the copyable URL from the client connection instead of the server bind address", () => {
    const result = webhookAddress(
      { ...endpoint, url: "http://127.0.0.1:8787/hooks/abc" },
      "https://home.example.net",
    );
    expect(result.address).toBe("https://home.example.net/hooks/abc");
    expect(result.copyable).toBe(true);
  });

  it("is not copyable when no base URL exists", () => {
    const result = webhookAddress(endpoint, null);
    expect(result.address).toBe("/hooks/abc");
    expect(result.copyable).toBe(false);
    expect(result.note).toBe("The local server address is not available.");
  });

  it("warns that loopback addresses only work on this computer", () => {
    const result = webhookAddress(endpoint, "http://127.0.0.1:8787");
    expect(result.address).toBe("http://127.0.0.1:8787/hooks/abc");
    expect(result.copyable).toBe(true);
    expect(result.note).toContain("Only this computer");
  });

  it("uses the direct connection origin for non-loopback hosts", () => {
    const result = webhookAddress(endpoint, "https://home.example.net");
    expect(result.address).toBe("https://home.example.net/hooks/abc");
    expect(result.copyable).toBe(true);
  });
});
