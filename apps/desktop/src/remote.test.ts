import { describe, expect, it, vi } from "vite-plus/test";
import {
  inspectRemoteServer,
  isCloudflareAccessUrl,
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
  it("normalizes HTTPS origins and rejects insecure, credentialed or ambiguous targets", () => {
    expect(normalizeRemoteOrigin(" https://cox.example.com:443/ ")).toBe("https://cox.example.com");
    for (const input of [
      "http://192.168.1.20:3773/",
      "http://127.0.0.1:3773/",
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

  it("preflights the descriptor and password policy with profile cookies and no followed redirects", async () => {
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
        credentials: "include",
        redirect: "manual",
      });
  });

  it.each([
    [
      "an Access login redirect",
      new Response(null, {
        status: 302,
        headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login/cox" },
      }),
    ],
    [
      "a same-origin Access redirect",
      new Response(null, { status: 302, headers: { location: "/cdn-cgi/access/login/cox" } }),
    ],
    [
      "an Access challenge",
      new Response(null, { status: 403, headers: { "cf-access-domain": "cox.example.com" } }),
    ],
    [
      "an Access authentication header",
      new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Cloudflare-Access realm="cox"' },
      }),
    ],
  ])("requires a gateway sign-in for %s", async (_name, gate) => {
    await expect(
      inspectRemoteServer(
        "https://cox.example.com",
        vi.fn(async () => gate),
      ),
    ).rejects.toMatchObject({
      name: "Error",
      origin: "https://cox.example.com",
      message: "Sign in to Cloudflare Access to connect to this server.",
    });
  });

  it("rejects other redirects and plain authorization failures", async () => {
    await expect(
      inspectRemoteServer(
        "https://cox.example.com",
        vi.fn(
          async () =>
            new Response(null, {
              status: 302,
              headers: { location: "https://evil.example.com/cdn-cgi/access/login/cox" },
            }),
        ),
      ),
    ).rejects.toThrow("redirected");
    await expect(
      inspectRemoteServer(
        "https://cox.example.com",
        vi.fn(async () => new Response(null, { status: 403 })),
      ),
    ).rejects.toThrow("HTTP 403");
  });

  it("recognizes only HTTPS Cloudflare Access team pages", () => {
    expect(isCloudflareAccessUrl("https://team.cloudflareaccess.com/cdn-cgi/access/login")).toBe(
      true,
    );
    expect(isCloudflareAccessUrl("http://team.cloudflareaccess.com/")).toBe(false);
    expect(isCloudflareAccessUrl("https://cloudflareaccess.com.evil.test/")).toBe(false);
  });

  it("rejects HTTP before making a remote request", async () => {
    const fetcher = remoteFetcher();
    await expect(inspectRemoteServer("http://192.168.1.20:3773", fetcher)).rejects.toThrow("HTTPS");
    expect(fetcher).not.toHaveBeenCalled();
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
