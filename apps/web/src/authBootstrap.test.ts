import { EnvironmentAuthInvalidError, type AuthSessionState } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { installEnvironmentHttpTest } from "../test/environmentHttpTest";
import {
  __resetServerAuthBootstrapForTests,
  resolveInitialServerAuthGateState,
  submitServerAuthCredential,
} from "./environments/primary";
import {
  invalidateServerAuthGate,
  PrimaryEnvironmentRequestError,
} from "./environments/primary/auth";
import { __setPrimaryHttpRunnerForTests } from "./lib/runtime";

const LOCAL_AUTH = {
  policy: "loopback-browser",
  loginMode: "local",
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "cox_session",
} as const;
const PASSWORD_AUTH = { ...LOCAL_AUTH, loginMode: "password" } as const;
const EXPIRES_AT = DateTime.makeUnsafe("2026-11-05T12:00:00.000Z");
const browserSession = {
  authenticated: true,
  scopes: [],
  sessionMethod: "browser-session-cookie",
  expiresAt: EXPIRES_AT,
} as const;
const session = (
  authenticated: boolean,
  auth: AuthSessionState["auth"] = LOCAL_AUTH,
): AuthSessionState => ({
  authenticated,
  auth,
});
const invalidCredential = () =>
  new EnvironmentAuthInvalidError({
    code: "auth_invalid",
    reason: "invalid_credential",
    traceId: "trace-invalid-password",
  });

let disposeHttpTest: (() => Promise<void>) | undefined;
async function installAuthApi(scenario: Parameters<typeof installEnvironmentHttpTest>[0]) {
  const testApi = await installEnvironmentHttpTest(scenario);
  disposeHttpTest = testApi.dispose;
  return testApi;
}

function useLiveAuthFetch(fetch: typeof globalThis.fetch) {
  __setPrimaryHttpRunnerForTests();
  vi.stubGlobal("window", { location: new URL("http://localhost/") });
  vi.stubGlobal("fetch", fetch);
}

describe("server authentication bootstrap", () => {
  afterEach(async () => {
    await disposeHttpTest?.();
    disposeHttpTest = undefined;
    __resetServerAuthBootstrapForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reuses an authenticated session without creating another one", async () => {
    const testApi = await installAuthApi({ session: () => Effect.succeed(session(true)) });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "authenticated" });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "authenticated" });
    expect(testApi.calls.session).toBe(1);
    expect(testApi.calls.browserSession).toEqual([]);
  });

  it("rechecks an explicitly invalidated authenticated session", async () => {
    let authenticated = true;
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(authenticated, PASSWORD_AUTH)),
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "authenticated" });

    authenticated = false;
    invalidateServerAuthGate();

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: PASSWORD_AUTH,
    });
    expect(testApi.calls.session).toBe(2);
  });

  it("automatically creates a local browser session with an empty payload after checking the session", async () => {
    let authenticated = false;
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(authenticated)),
      browserSession: () => {
        expect(testApi.calls.session).toBe(1);
        authenticated = true;
        return Effect.succeed(browserSession);
      },
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "authenticated" });
    expect(testApi.calls.browserSession).toEqual([{}]);
    expect(testApi.calls.session).toBe(2);
  });

  it("shares a single local bootstrap between concurrent callers", async () => {
    let authenticated = false;
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(authenticated)),
      browserSession: () => {
        authenticated = true;
        return Effect.succeed(browserSession);
      },
    });
    const states = await Promise.all([
      resolveInitialServerAuthGateState(),
      resolveInitialServerAuthGateState(),
      resolveInitialServerAuthGateState(),
    ]);
    expect(states).toEqual(Array.from({ length: 3 }, () => ({ status: "authenticated" })));
    expect(testApi.calls.browserSession).toEqual([{}]);
  });

  it("asks for a password without automatically posting credentials", async () => {
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(false, PASSWORD_AUTH)),
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: PASSWORD_AUTH,
    });
    expect(testApi.calls.browserSession).toEqual([]);
  });

  it.each(["local", "password"] as const)(
    "strips legacy URL tokens without exchanging them in %s mode",
    async (loginMode) => {
      const replaceState = vi.fn();
      vi.stubGlobal("window", {
        location: new URL(
          "http://localhost/?token=query-secret&theme=dark#token=hash-secret&other=value",
        ),
        history: { state: { preserved: true }, replaceState },
      });
      vi.stubGlobal("document", { title: "Cox" });
      let authenticated = false;
      const testApi = await installAuthApi({
        session: () => Effect.succeed(session(authenticated, { ...LOCAL_AUTH, loginMode })),
        browserSession: () => {
          authenticated = true;
          return Effect.succeed(browserSession);
        },
      });
      const result = await resolveInitialServerAuthGateState();
      expect(result.status).toBe(loginMode === "local" ? "authenticated" : "requires-auth");
      expect(testApi.calls.browserSession).toEqual(loginMode === "local" ? [{}] : []);
      expect(replaceState).toHaveBeenCalledWith(
        { preserved: true },
        "Cox",
        "http://localhost/?theme=dark#other=value",
      );
    },
  );

  it("submits a trimmed password and verifies the session before caching authentication", async () => {
    let authenticated = false;
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(authenticated, PASSWORD_AUTH)),
      browserSession: () => {
        authenticated = true;
        return Effect.succeed(browserSession);
      },
    });
    await submitServerAuthCredential("  correct-password  ");
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({ status: "authenticated" });
    expect(testApi.calls.browserSession).toEqual([{ credential: "correct-password" }]);
    expect(testApi.calls.session).toBe(1);
  });

  it("rejects empty passwords without making a request", async () => {
    const testApi = await installAuthApi({});
    await expect(submitServerAuthCredential("  ")).rejects.toThrow(
      "Enter your password to continue.",
    );
    expect(testApi.calls.browserSession).toEqual([]);
  });

  it("reports rejected passwords without caching false success", async () => {
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(false, PASSWORD_AUTH)),
      browserSession: () => Effect.fail(invalidCredential()),
    });
    await expect(submitServerAuthCredential("wrong-password")).rejects.toThrow(
      "Invalid password. Check the password and try again.",
    );
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: PASSWORD_AUTH,
    });
    expect(testApi.calls.browserSession).toEqual([{ credential: "wrong-password" }]);
  });

  it("does not fall back to a credential exchange when local session creation fails", async () => {
    const testApi = await installAuthApi({
      session: () => Effect.succeed(session(false)),
      browserSession: () => Effect.fail(invalidCredential()),
    });
    await expect(resolveInitialServerAuthGateState()).rejects.toThrow();
    await expect(resolveInitialServerAuthGateState()).rejects.toThrow();
    expect(testApi.calls.browserSession).toEqual([{}, {}]);
    expect(testApi.calls.session).toBe(2);
  });

  it.each([
    { operation: "fetch-session-state", stalledEndpoint: "session" },
    { operation: "create-browser-session", stalledEndpoint: "browser-session" },
  ] as const)(
    "bounds and retries a stalled $stalledEndpoint request",
    async ({ operation, stalledEndpoint }) => {
      vi.useFakeTimers();
      vi.setSystemTime("2026-11-05T12:00:00.000Z");
      let requests = 0;
      let aborts = 0;
      useLiveAuthFetch((input, init) => {
        const request = new Request(input, init);
        requests += 1;
        if (stalledEndpoint === "browser-session" && request.method === "GET") {
          return Promise.resolve(Response.json(session(false)));
        }
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => {
              aborts += 1;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      });

      let settled = false;
      const outcomePromise = resolveInitialServerAuthGateState().then(
        () => {
          settled = true;
          return null;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(16_000);

      expect(settled).toBe(true);
      const error = await outcomePromise;
      expect(error).toBeInstanceOf(PrimaryEnvironmentRequestError);
      expect(error).toMatchObject({ operation });
      expect(requests).toBeGreaterThan(1);
      expect(aborts).toBe(requests - (stalledEndpoint === "browser-session" ? 1 : 0));
    },
  );

  it.each([
    { cause: () => new TypeError("Network unavailable"), name: "TypeError" },
    { cause: () => new DOMException("Aborted", "AbortError"), name: "AbortError" },
  ])("retries a response-less transport $name and recovers", async ({ cause }) => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-11-05T12:00:00.000Z");
    let requests = 0;
    useLiveAuthFetch(() => {
      requests += 1;
      return requests === 1
        ? Promise.reject(cause())
        : Promise.resolve(Response.json(session(false, PASSWORD_AUTH)));
    });

    const outcomePromise = resolveInitialServerAuthGateState().then(
      (value) => ({ status: "resolved", value }) as const,
      (error: unknown) => ({ status: "rejected", error }) as const,
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(outcomePromise).resolves.toEqual({
      status: "resolved",
      value: { status: "requires-auth", auth: PASSWORD_AUTH },
    });
    expect(requests).toBe(2);
  });

  it.each([401, 403, 500])("fails immediately for HTTP %i", async (status) => {
    let requests = 0;
    useLiveAuthFetch(() => {
      requests += 1;
      return Promise.resolve(new Response(null, { status }));
    });

    await expect(resolveInitialServerAuthGateState()).rejects.toMatchObject({
      _tag: "PrimaryEnvironmentRequestError",
      status,
    });
    expect(requests).toBe(1);
  });
});
