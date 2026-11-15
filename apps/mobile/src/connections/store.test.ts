import { describe, expect, it } from "vite-plus/test";
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

function createStore(storage: ConnectionStorage, fetcher?: typeof fetch): ConnectionStore {
  const ids = [...IDS];
  return new ConnectionStore({
    storage,
    ...(fetcher ? { fetcher } : {}),
    now: () => "2026-11-15T12:00:00.000Z",
    newId: () => ids.shift() ?? IDS[2],
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
  it("persists inspected server metadata and only the vault preference", async () => {
    const storage = new MemoryStorage();
    const { fetcher } = admissionFetcher();
    const store = createStore(storage, fetcher);

    const profile = await store.saveServer(
      draft("https://cox.example.com", { savePasswordInVault: true }),
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

    store.forget(saved.id);

    expect(store.getSnapshot().profiles).toEqual([]);
    expect(createStore(storage, fetcher).getSnapshot().profiles).toEqual([]);
  });
});
