import { describe, expect, it, vi } from "vite-plus/test";
import { VaultError, type BiometricVault } from "../vault/biometricVault";
import { GatewaySignInError } from "../workspace/workspacePlugin";
import { RemoteEnvironmentMismatchError } from "@t3tools/shared/remoteServerAdmission";
import {
  CONNECTION_STORAGE_KEY,
  ConnectionStore,
  type ConnectionStorage,
  type ServerDraft,
} from "./store";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
] as const;

function deferred() {
  let resolve: () => void = () => {
    throw new Error("Promise not initialized");
  };
  let reject: (reason: unknown) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class MemoryStorage implements ConnectionStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

function admissionFetcher(environmentId: () => string = () => "env-mobile-a") {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    requests.push(url);
    if (url.endsWith("/.well-known/t3/environment")) {
      return Response.json({
        environmentId: environmentId(),
        label: "Test Cox",
        serverVersion: "1.2.3",
      });
    }
    if (url.endsWith("/api/auth/session")) {
      return Response.json({ auth: { loginMode: "password" } });
    }
    return new Response("Not found", { status: 404 });
  };
  return { fetcher, requests };
}

function createStore(
  storage: ConnectionStorage,
  fetcher?: typeof fetch,
  vault?: BiometricVault,
): ConnectionStore {
  const ids = [...IDS];
  return new ConnectionStore({
    storage,
    ...(fetcher ? { fetcher } : {}),
    now: () => "2026-11-15T12:00:00.000Z",
    newId: () => ids.shift() ?? IDS[2],
    ...(vault ? { vault } : {}),
  });
}

function draft(origin: string, overrides: Partial<ServerDraft> = {}): ServerDraft {
  return {
    label: "Workstation",
    origin,
    allowInsecureHttp: false,
    savePasswordInVault: false,
    ...overrides,
  };
}

describe("mobile connection store", () => {
  it("persists inspected metadata without the password after native vault saving", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const savePassword = vi.fn().mockResolvedValue(undefined);
    const store = createStore(storage, fetcher, {
      savePassword,
      unlockAndAutofillPassword: vi.fn(),
      deletePassword: vi.fn(),
    });

    const profile = await store.saveServer(
      draft("https://cox.example.com", {
        savePasswordInVault: true,
        password: "secret-test-password",
      }),
    );

    expect(profile).toEqual({
      id: IDS[0],
      label: "Workstation",
      origin: "https://cox.example.com",
      allowInsecureHttp: false,
      pinnedEnvironmentId: "env-mobile-a",
      lastServerVersion: "1.2.3",
      hasSavedPassword: true,
      lastThreadPath: null,
      lastConnectedAt: null,
      healthStatus: "unverified",
    });
    expect(profile).not.toHaveProperty("password");
    expect(savePassword).toHaveBeenCalledWith({
      profileId: IDS[0],
      canonicalOrigin: profile.origin,
      password: "secret-test-password",
      requireBiometric: true,
    });
    expect(storage.getItem(CONNECTION_STORAGE_KEY)).not.toContain("secret-test-password");
    expect(storage.getItem(CONNECTION_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 1, profiles: [profile] }),
    );
  });

  it.each([
    "http://192.0.2.50:3773",
    "https://cox.example.com?token=abc",
    "https://user:pass@cox.example.com",
    "cox-pair://12345",
  ])("rejects %s before any network preflight", async (origin) => {
    const { fetcher, requests } = admissionFetcher();
    const store = createStore(new MemoryStorage(), fetcher);

    await expect(store.saveServer(draft(origin))).rejects.toMatchObject({
      code: "malformed_input",
    });
    expect(requests).toEqual([]);
  });

  it("saves plain HTTP only with the explicit transport opt-in", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);

    const profile = await store.saveServer(
      draft("http://192.0.2.50:3773", { allowInsecureHttp: true }),
    );

    expect(profile.origin).toBe("http://192.0.2.50:3773");
    expect(profile.allowInsecureHttp).toBe(true);
  });

  it("persists touch reordering across store reloads", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);
    await store.saveServer(draft("https://one.example.com"));
    const second = await store.saveServer(draft("https://two.example.com"));

    store.move(second.id, 0);

    const restored = createStore(storage, fetcher);
    expect(restored.getSnapshot().profiles.map((profile) => profile.origin)).toEqual([
      "https://two.example.com",
      "https://one.example.com",
    ]);
  });

  it("records a verified connection and identity mismatch without losing history", async () => {
    const storage = new MemoryStorage();
    let currentEnvironment = "env-mobile-a";
    const { fetcher } = admissionFetcher(() => currentEnvironment);
    const store = createStore(storage, fetcher);
    const saved = await store.saveServer(draft("https://cox.example.com"));

    const connected = await store.connect(saved.id);

    expect(connected.lastConnectedAt).toBe("2026-11-15T12:00:00.000Z");
    expect(connected.pinnedEnvironmentId).toBe("env-mobile-a");
    expect(connected.healthStatus).toBe("verified");
    currentEnvironment = "env-mobile-b";
    await expect(store.connect(saved.id)).rejects.toBeInstanceOf(RemoteEnvironmentMismatchError);
    const changed = store.getSnapshot().profiles[0];
    expect(changed?.healthStatus).toBe("identity_mismatch");
    expect(changed?.pinnedEnvironmentId).toBe("env-mobile-a");
    expect(changed?.lastConnectedAt).toBe("2026-11-15T12:00:00.000Z");
  });

  it("marks a changed environment identity without overwriting saved history", async () => {
    let currentEnvironment = "env-mobile-a";
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher(() => currentEnvironment);
    const store = createStore(storage, fetcher);
    const saved = await store.saveServer(draft("https://cox.example.com"));
    currentEnvironment = "env-mobile-b";
    await expect(store.connect(saved.id)).rejects.toBeInstanceOf(RemoteEnvironmentMismatchError);
    const changed = store.getSnapshot().profiles[0];
    expect(changed?.healthStatus).toBe("identity_mismatch");
    expect(changed?.pinnedEnvironmentId).toBe("env-mobile-a");
    expect(changed?.lastConnectedAt).toBeNull();
  });

  it("normalizes protocol labels from each canonical origin", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);
    const secure = await store.saveServer(
      draft("https://cox.example.com", { allowInsecureHttp: true }),
    );
    const insecure = await store.saveServer(
      draft("http://192.0.2.50:3773", { allowInsecureHttp: true }),
    );

    expect(secure.origin.startsWith("http://") ? "HTTP Opt-In" : "HTTPS").toBe("HTTPS");
    expect(insecure.origin.startsWith("http://") ? "HTTP Opt-In" : "HTTPS").toBe("HTTP Opt-In");
    expect(secure.allowInsecureHttp).toBe(false);
  });

  it("forgets a profile from both memory and durable storage", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);
    const saved = await store.saveServer(draft("https://cox.example.com"));

    await store.forget(saved.id);

    expect(store.getSnapshot().profiles).toEqual([]);
    expect(createStore(storage, fetcher).getSnapshot().profiles).toEqual([]);
  });

  it("keeps the saved profile until vault deletion succeeds and retains it after failure", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const deletion = deferred();
    const store = createStore(storage, fetcher, {
      savePassword: vi.fn().mockResolvedValue(undefined),
      unlockAndAutofillPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: () => deletion.promise,
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );
    const forgotten = store.forget(saved.id);
    expect(store.getSnapshot().profiles).toEqual([saved]);
    deletion.reject(new VaultError("unavailable"));
    await expect(forgotten).rejects.toBeInstanceOf(VaultError);
    expect(createStore(storage, fetcher).getSnapshot().profiles).toEqual([saved]);
  });

  it("does not delete a saved credential when profile persistence fails during Forget", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const deletePassword = vi.fn().mockResolvedValue(undefined);
    const store = createStore(storage, fetcher, {
      savePassword: vi.fn().mockResolvedValue(undefined),
      unlockAndAutofillPassword: vi.fn(),
      deletePassword,
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );
    const previousRaw = storage.getItem(CONNECTION_STORAGE_KEY);
    let rejectUpdate = true;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (
        key === CONNECTION_STORAGE_KEY &&
        JSON.parse(value).profiles.length === 0 &&
        rejectUpdate
      ) {
        rejectUpdate = false;
        throw new DOMException("Storage write refused", "QuotaExceededError");
      }
      MemoryStorage.prototype.setItem.call(storage, key, value);
    });

    await expect(store.forget(saved.id)).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(deletePassword).not.toHaveBeenCalled();
    expect(storage.getItem(CONNECTION_STORAGE_KEY)).toBe(previousRaw);
    expect(store.getSnapshot().profiles).toEqual([saved]);
  });

  it("restores persisted profile metadata after vault deletion failure and can retry", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const deletePassword = vi
      .fn<BiometricVault["deletePassword"]>()
      .mockRejectedValueOnce(new VaultError("unavailable"))
      .mockResolvedValueOnce(undefined);
    const store = createStore(storage, fetcher, {
      savePassword: vi.fn().mockResolvedValue(undefined),
      unlockAndAutofillPassword: vi.fn(),
      deletePassword,
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );
    const previousRaw = storage.getItem(CONNECTION_STORAGE_KEY);

    await expect(store.forget(saved.id)).rejects.toBeInstanceOf(VaultError);
    expect(storage.getItem(CONNECTION_STORAGE_KEY)).toBe(previousRaw);
    expect(JSON.parse(previousRaw ?? "{}").profiles[0].hasSavedPassword).toBe(true);
    expect(store.getSnapshot().profiles).toEqual([saved]);

    await store.forget(saved.id);

    expect(storage.getItem(CONNECTION_STORAGE_KEY)).toBe(
      JSON.stringify({ version: 1, profiles: [] }),
    );
    expect(store.getSnapshot().profiles).toEqual([]);
    expect(deletePassword).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing saved credential when clearing its profile flag cannot persist", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const deletePassword = vi.fn().mockResolvedValue(undefined);
    const store = createStore(storage, fetcher, {
      savePassword: vi.fn().mockResolvedValue(undefined),
      unlockAndAutofillPassword: vi.fn(),
      deletePassword,
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );
    const previousRaw = storage.getItem(CONNECTION_STORAGE_KEY);
    let rejectUpdate = true;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (
        key === CONNECTION_STORAGE_KEY &&
        JSON.parse(value).profiles[0].hasSavedPassword === false &&
        rejectUpdate
      ) {
        rejectUpdate = false;
        throw new DOMException("Storage write refused", "QuotaExceededError");
      }
      MemoryStorage.prototype.setItem.call(storage, key, value);
    });

    await expect(
      store.saveServer(
        draft("https://cox.example.com", { id: saved.id, savePasswordInVault: false }),
      ),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });

    expect(deletePassword).not.toHaveBeenCalled();
    expect(storage.getItem(CONNECTION_STORAGE_KEY)).toBe(previousRaw);
    expect(store.getSnapshot().profiles).toEqual([saved]);
  });

  it("records a connection only after vault unlock completes", async () => {
    const { fetcher } = admissionFetcher();
    const unlock = deferred();
    const started = deferred();
    const store = createStore(new MemoryStorage(), fetcher, {
      savePassword: vi.fn().mockResolvedValue(undefined),
      unlockAndAutofillPassword: () => {
        started.resolve();
        return unlock.promise;
      },
      deletePassword: vi.fn().mockResolvedValue(undefined),
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );
    const connecting = store.connect(saved.id);
    await started.promise;
    expect(store.getSnapshot().profiles[0]?.lastConnectedAt).toBeNull();
    unlock.resolve();
    expect((await connecting).lastConnectedAt).toBe("2026-11-15T12:00:00.000Z");
  });

  it("refuses a changed origin without a replacement credential", async () => {
    const { fetcher } = admissionFetcher();
    const savePassword = vi.fn().mockResolvedValue(undefined);
    const store = createStore(new MemoryStorage(), fetcher, {
      savePassword,
      unlockAndAutofillPassword: vi.fn(),
      deletePassword: vi.fn(),
    });
    const saved = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
    );

    await expect(
      store.saveServer(
        draft("https://other.example.com", { id: saved.id, savePasswordInVault: true }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(store.getSnapshot().profiles).toEqual([saved]);
    expect(savePassword).toHaveBeenCalledTimes(1);
  });

  it("authenticates Cloudflare Access in the isolated profile before saving and reconnecting", async () => {
    const storage = new MemoryStorage();
    const authedProfiles = new Set<string>();
    const signInToGateway = vi.fn(async ({ profileId }: { readonly profileId: string }) => {
      authedProfiles.add(profileId);
    });
    const cleanupUnsavedProfile = vi.fn().mockResolvedValue(undefined);
    const store = new ConnectionStore({
      storage,
      now: () => "2026-11-17T03:30:00.000Z",
      newId: () => IDS[0],
      signInToGateway,
      cleanupUnsavedProfile,
      profileFetcher:
        ({ profileId, origin }) =>
        async (input) => {
          const url =
            input instanceof Request ? input.url : input instanceof URL ? input.href : input;
          if (!authedProfiles.has(profileId)) {
            return new Response(null, {
              status: 302,
              headers: {
                location: `https://broad-sun-37d6.cloudflareaccess.com/cdn-cgi/access/login?redirect_url=${encodeURIComponent(new URL(url).pathname)}`,
              },
            });
          }
          if (url === `${origin}/.well-known/t3/environment`) {
            return Response.json({
              environmentId: "env-cf-access",
              label: "Remote CF Box",
              serverVersion: "0.1.98",
            });
          }
          return Response.json({ auth: { loginMode: "password" } });
        },
    });

    const saved = await store.saveServer(draft("https://dd.yang.sarl", { label: "" }));

    expect(signInToGateway).toHaveBeenCalledWith({
      profileId: IDS[0],
      origin: "https://dd.yang.sarl",
    });
    expect(cleanupUnsavedProfile).not.toHaveBeenCalled();
    expect(saved).toMatchObject({
      id: IDS[0],
      label: "Remote CF Box",
      origin: "https://dd.yang.sarl",
      pinnedEnvironmentId: "env-cf-access",
      lastServerVersion: "0.1.98",
    });

    authedProfiles.clear();
    const connected = await store.connect(saved.id);
    expect(signInToGateway).toHaveBeenCalledTimes(2);
    expect(connected.healthStatus).toBe("verified");
  });

  it("wipes temporary profile storage when Cloudflare Access sign-in is cancelled during first add", async () => {
    const storage = new MemoryStorage();
    const cleanupUnsavedProfile = vi.fn().mockResolvedValue(undefined);
    const store = new ConnectionStore({
      storage,
      newId: () => IDS[0],
      signInToGateway: () => Promise.reject(new GatewaySignInError("gateway_cancelled")),
      cleanupUnsavedProfile,
      profileFetcher: () => async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
        }),
    });

    await expect(store.saveServer(draft("https://dd.yang.sarl"))).rejects.toMatchObject({
      code: "gateway_cancelled",
    });

    expect(cleanupUnsavedProfile).toHaveBeenCalledWith({
      id: IDS[0],
      origin: "https://dd.yang.sarl",
    });
    expect(store.getSnapshot().profiles).toEqual([]);
  });

  it("persists only safe workspace relative paths on rememberThreadPath", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);
    const saved = await store.saveServer(draft("https://cox.example.com"));

    store.rememberThreadPath(saved.id, "//evil.example/phish");
    store.rememberThreadPath(saved.id, "/\\evil");
    expect(store.getSnapshot().profiles[0]?.lastThreadPath).toBeNull();

    store.rememberThreadPath(saved.id, "/env-mobile-a/thread-42");
    expect(store.getSnapshot().profiles[0]?.lastThreadPath).toBe("/env-mobile-a/thread-42");
  });

  it("does not save a profile if the native vault refuses its credential", async () => {
    const { fetcher } = admissionFetcher();
    const store = createStore(new MemoryStorage(), fetcher, {
      savePassword: vi.fn().mockRejectedValue(new VaultError("unavailable")),
      unlockAndAutofillPassword: vi.fn(),
      deletePassword: vi.fn(),
    });

    await expect(
      store.saveServer(
        draft("https://cox.example.com", { savePasswordInVault: true, password: "secret" }),
      ),
    ).rejects.toBeInstanceOf(VaultError);
    expect(store.getSnapshot().profiles).toEqual([]);
  });
});
