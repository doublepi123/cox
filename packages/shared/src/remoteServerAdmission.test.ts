import { describe, expect, it, vi } from "vite-plus/test";
import {
  inspectRemoteServer,
  isCloudflareAccessGate,
  isCloudflareAccessUrl,
  normalizeRemoteOrigin,
  RemoteGatewayRequiredError,
} from "./remoteServerAdmission.ts";

const descriptor = {
  environmentId: "env-actual",
  label: " Build server ",
  serverVersion: " 1.2.3 ",
};

function fetcherFor(loginMode = "password", metadata: unknown = descriptor): typeof fetch {
  return async (input) =>
    Response.json(String(input).endsWith("/api/auth/session") ? { auth: { loginMode } } : metadata);
}

describe("remote admission transport policy", () => {
  it.each([
    [" https://COX.example.com:443/ ", {}, "https://cox.example.com"],
    ["http://100.64.0.10:3773/", { allowInsecureHttp: true }, "http://100.64.0.10:3773"],
    ["https://cox.example.com", { allowInsecureHttp: true }, "https://cox.example.com"],
  ])("canonicalizes admitted origin %s", (input, options, expected) => {
    expect(normalizeRemoteOrigin(input, options)).toBe(expected);
  });

  it.each([
    "",
    "not a URL",
    "ftp://cox.example.com",
    "https://user:pw@cox.example.com",
    "http://user@cox.example.com",
    "https://cox.example.com/sub",
    "https://cox.example.com/?a=1",
    "https://example.com/?",
    "https://example.com/#",
    "https://example.com/?#",
    "https://cox.example.com/#fragment",
  ])("rejects malformed origins even with HTTP opted in: %s", (input) => {
    expect(() => normalizeRemoteOrigin(input, { allowInsecureHttp: true })).toThrow(
      expect.objectContaining({ code: "malformed_input" }),
    );
  });

  it.each([{}, { allowInsecureHttp: false }])(
    "requires explicit HTTP opt-in: %j",
    async (options) => {
      const fetcher = vi.fn(fetcherFor());
      await expect(
        inspectRemoteServer("http://127.0.0.1:3773", { ...options, fetcher }),
      ).rejects.toMatchObject({ code: "malformed_input" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});

describe("remote admission identity and authentication", () => {
  it("reads the environment descriptor and session at the same time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher: typeof fetch = async (input) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return fetcherFor()(input);
    };
    const started = performance.now();
    await inspectRemoteServer("https://cox.example.com", { fetcher });
    const elapsed = performance.now() - started;
    expect(maxInFlight).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(80);
  });

  it("admits an opted-in HTTP server with a matching pin and trims display metadata", async () => {
    await expect(
      inspectRemoteServer("http://100.64.0.10:3773", {
        allowInsecureHttp: true,
        pinnedEnvironmentId: "env-actual",
        fetcher: fetcherFor(),
      }),
    ).resolves.toEqual({
      origin: "http://100.64.0.10:3773",
      environmentId: "env-actual",
      label: "Build server",
      serverVersion: "1.2.3",
    });
  });

  it.each(["env-expected", ""])("rejects changed identity pinned as %j", async (pin) => {
    await expect(
      inspectRemoteServer("https://cox.example.com", {
        pinnedEnvironmentId: pin,
        fetcher: fetcherFor(),
      }),
    ).rejects.toMatchObject({
      code: "environment_id_mismatch",
      expectedEnvironmentId: pin,
      actualEnvironmentId: "env-actual",
    });
  });

  it.each([
    ["https://cox.example.com", {}],
    ["http://100.64.0.10:3773", { allowInsecureHttp: true, requirePasswordAuth: false }],
    ["http://127.0.0.1:3773", { allowInsecureHttp: true }],
    ["https://localhost.evil.test", { requirePasswordAuth: false }],
    ["https://[::ffff:127.0.0.1]", { requirePasswordAuth: false }],
  ])("requires password authentication at %s", async (origin, options) => {
    await expect(
      inspectRemoteServer(origin, { ...options, fetcher: fetcherFor("local") }),
    ).rejects.toMatchObject({ code: "password_required" });
  });

  it.each(["https://localhost", "https://127.0.0.2", "https://[::1]"])(
    "permits local authentication only when explicitly allowed on loopback %s",
    async (origin) => {
      await expect(
        inspectRemoteServer(origin, { requirePasswordAuth: false, fetcher: fetcherFor("local") }),
      ).resolves.toMatchObject({ origin, environmentId: "env-actual" });
    },
  );

  it.each([
    null,
    [],
    {},
    { ...descriptor, environmentId: " " },
    { ...descriptor, label: 2 },
    { ...descriptor, serverVersion: "" },
  ])("rejects malformed descriptor %j", async (metadata) => {
    await expect(
      inspectRemoteServer("https://cox.example.com", { fetcher: fetcherFor("password", metadata) }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed session metadata even when loopback password enforcement is disabled", async () => {
    await expect(
      inspectRemoteServer("https://localhost", {
        requirePasswordAuth: false,
        fetcher: fetcherFor("unknown"),
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("remote admission network boundaries", () => {
  it.each(["/.well-known/t3/environment", "/api/auth/session"])(
    "detects an Access gate at %s without following it",
    async (gatePath) => {
      const fetcher = vi.fn<typeof fetch>(async (input) =>
        String(input).endsWith(gatePath)
          ? new Response(null, {
              status: 302,
              headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
            })
          : Response.json(descriptor),
      );
      await expect(
        inspectRemoteServer("https://cox.example.com", { fetcher }),
      ).rejects.toBeInstanceOf(RemoteGatewayRequiredError);
      for (const [, init] of fetcher.mock.calls)
        expect(init).toMatchObject({
          redirect: "manual",
          credentials: "include",
          cache: "no-store",
        });
    },
  );

  it.each([
    [302, { location: "/cdn-cgi/access/login" }, true],
    [401, { "www-authenticate": "Cloudflare-Access" }, true],
    [403, { "cf-access-domain": "cox.example.com" }, true],
    [403, {}, false],
    [302, { location: "https://evil.test/cdn-cgi/access/login" }, false],
    [302, { location: "http://team.cloudflareaccess.com" }, false],
    [302, { location: "https://user:pw@team.cloudflareaccess.com" }, false],
    [302, { location: "https://[" }, false],
    [302, {}, false],
  ] satisfies ReadonlyArray<readonly [number, Record<string, string>, boolean]>)(
    "classifies status %i with headers %j",
    (status, headers, expected) => {
      expect(isCloudflareAccessGate("https://cox.example.com", status, new Headers(headers))).toBe(
        expected,
      );
    },
  );

  it.each([
    "https://cloudflareaccess.com.evil.test",
    "https://[",
    "http://team.cloudflareaccess.com",
  ])("rejects untrusted gateway URL %s", (url) => expect(isCloudflareAccessUrl(url)).toBe(false));

  it.each([
    [
      () => new Response(null, { status: 302, headers: { location: "https://other.example.com" } }),
      "redirect",
    ],
    [() => new Response(null, { status: 503 }), "http_error"],
    [() => new Response("<html>"), "invalid_response"],
    [() => new Response("x".repeat(1_000_001)), "invalid_response"],
  ])("rejects unsafe or invalid network responses", async (response, code) => {
    await expect(
      inspectRemoteServer("https://cox.example.com", { fetcher: async () => response() }),
    ).rejects.toMatchObject({ code });
  });

  it("propagates cancellation through preflight", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher: typeof fetch = async (_input, init) => {
      init?.signal?.throwIfAborted();
      return Response.json(descriptor);
    };
    await expect(
      inspectRemoteServer("https://cox.example.com", { fetcher, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
