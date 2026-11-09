import { describe, expect, it, vi } from "vite-plus/test";
import {
  inspectRemoteServer,
  newRemoteProfileId,
  normalizeRemoteOrigin,
  remotePartition,
} from "./remote.ts";

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function remoteFetcher() {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/.well-known/t3/environment"))
      return response({
        environmentId: "environment-1",
        label: "Build server",
        serverVersion: "0.1.56",
      });
    if (url.endsWith("/api/auth/session"))
      return response({ authenticated: false, auth: { loginMode: "password" } });
    return response({}, 404);
  });
  return fetcher;
}

describe("remote Cox connections", () => {
  it("normalizes HTTP(S) origins and rejects credential or ambiguous targets", () => {
    expect(normalizeRemoteOrigin(" https://cox.example.com:443/ ")).toBe("https://cox.example.com");
    expect(normalizeRemoteOrigin(" http://192.168.1.20:3773/ ")).toBe("http://192.168.1.20:3773");
    for (const input of [
      "ftp://cox.example.com",
      "https://user:password@cox.example.com",
      "https://cox.example.com/cox",
      "https://cox.example.com/?token=secret",
      "https://cox.example.com/#token",
    ])
      expect(() => normalizeRemoteOrigin(input)).toThrow();
  });

  it("uses validated profile IDs in isolated Electron partitions", () => {
    const id = newRemoteProfileId();
    expect(remotePartition(id)).toBe(`persist:cox-remote-${id}`);
    expect(() => remotePartition("../cox-desktop")).toThrow("Invalid remote server identity.");
  });

  it("preflights the descriptor and password policy without credentials or redirects", async () => {
    const fetcher = remoteFetcher();
    await expect(inspectRemoteServer("https://cox.example.com", fetcher)).resolves.toEqual({
      origin: "https://cox.example.com",
      environmentId: "environment-1",
      label: "Build server",
      serverVersion: "0.1.56",
    });
    for (const call of fetcher.mock.calls)
      expect(call[1]).toMatchObject({
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
      });
  });

  it("preflights an HTTP server without credentials and still requires a password", async () => {
    const fetcher = remoteFetcher();
    await expect(inspectRemoteServer("http://192.168.1.20:3773", fetcher)).resolves.toMatchObject({
      origin: "http://192.168.1.20:3773",
    });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "http://192.168.1.20:3773/.well-known/t3/environment",
      "http://192.168.1.20:3773/api/auth/session",
    ]);
  });

  it("rejects passwordless HTTP servers", async () => {
    const fetcher = remoteFetcher();
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/api/auth/session")
        ? response({ authenticated: false, auth: { loginMode: "local" } })
        : response({
            environmentId: "environment-1",
            label: "Build server",
            serverVersion: "0.1.56",
          }),
    );
    await expect(inspectRemoteServer("http://192.168.1.20:3773", fetcher)).rejects.toThrow(
      "COX_AUTH_PASSWORD",
    );
  });

  it("rejects passwordless HTTPS servers", async () => {
    const fetcher = remoteFetcher();
    fetcher.mockImplementation(async (input) =>
      String(input).endsWith("/api/auth/session")
        ? response({ authenticated: false, auth: { loginMode: "local" } })
        : response({
            environmentId: "environment-1",
            label: "Build server",
            serverVersion: "0.1.56",
          }),
    );
    await expect(inspectRemoteServer("https://cox.example.com", fetcher)).rejects.toThrow(
      "COX_AUTH_PASSWORD",
    );
  });

  it("rejects non-Cox metadata and failed requests", async () => {
    await expect(
      inspectRemoteServer(
        "https://cox.example.com",
        vi.fn(async () => response({})),
      ),
    ).rejects.toThrow("valid Cox environment descriptor");
    await expect(
      inspectRemoteServer(
        "https://cox.example.com",
        vi.fn(async () => response({}, 503)),
      ),
    ).rejects.toThrow("HTTP 503");
  });
});
