import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readPrimaryEnvironmentTarget, resolvePrimaryEnvironmentHttpUrl } from ".";

function installTestBrowser(url: string) {
  vi.stubGlobal("window", { location: new URL(url), history: { replaceState: vi.fn() } });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("same-origin environment bootstrap", () => {
  it("uses the frontend origin for development proxy requests", () => {
    installTestBrowser("http://127.0.0.1:5733/thread");
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://127.0.0.1:5733/.well-known/t3/environment",
    );
    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "http://127.0.0.1:5733/",
      wsBaseUrl: "ws://127.0.0.1:5733/",
    });
  });
  it("preserves HTTPS for both HTTP and WebSocket connections", () => {
    installTestBrowser("https://localhost:4773/thread");
    expect(readPrimaryEnvironmentTarget()?.target).toEqual({
      httpBaseUrl: "https://localhost:4773/",
      wsBaseUrl: "wss://localhost:4773/",
    });
  });
  it("ignores external connection overrides", () => {
    installTestBrowser("http://localhost:4773/");
    vi.stubEnv("VITE_HTTP_URL", "https://external.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://external.example.com");
    expect(resolvePrimaryEnvironmentHttpUrl("/.well-known/t3/environment")).toBe(
      "http://localhost:4773/.well-known/t3/environment",
    );
  });
  it("rejects non-HTTP browser origins", () => {
    installTestBrowser("file:///tmp/index.html");
    expect(() => readPrimaryEnvironmentTarget()).toThrow();
  });
});
