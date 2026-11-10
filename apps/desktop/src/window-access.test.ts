import { describe, expect, it } from "vite-plus/test";
import { trustedWindowAccess } from "./window-access.ts";

describe("desktop window access", () => {
  it("binds trusted shell messages to the owning origin and main frame", () => {
    const local = { origin: "http://127.0.0.1:3773", kind: "local" } as const;
    const remote = { origin: "https://remote.example.com", kind: "remote" } as const;
    const frame = {};
    expect(trustedWindowAccess(remote, frame, frame, remote.origin + "/settings")).toBe(remote);
    expect(trustedWindowAccess(local, frame, frame, local.origin + "/thread")).toBe(local);
    expect(trustedWindowAccess(remote, frame, frame, local.origin)).toBeUndefined();
    expect(trustedWindowAccess(local, frame, frame, remote.origin)).toBeUndefined();
    expect(trustedWindowAccess(remote, frame, {}, remote.origin)).toBeUndefined();
    expect(trustedWindowAccess(undefined, frame, frame, remote.origin)).toBeUndefined();
  });

  it("never upgrades a remote sender to local when URLs or frame identities are spoofed", () => {
    const remote = { origin: "https://remote.example.com", kind: "remote" } as const;
    const frame = {};
    for (const url of [
      "https://remote.example.com.evil.test/",
      "https://user:password@remote.example.com/",
      "http://remote.example.com/",
      "data:text/html,remote",
    ])
      expect(trustedWindowAccess(remote, frame, frame, url)).toBeUndefined();
    expect(trustedWindowAccess(remote, frame, frame, remote.origin)?.kind).toBe("remote");
  });
});
