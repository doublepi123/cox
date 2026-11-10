import { describe, expect, it } from "vite-plus/test";
import {
  backendEnvironment,
  backendOriginFromOutput,
  isBackendNavigation,
  isExternalNavigation,
  settingsWindowUrl,
} from "./config.ts";

describe("desktop local-only policy", () => {
  it("keeps settings navigation within the owned settings routes and retains its context", () => {
    const origin = "http://127.0.0.1:3773";
    expect(
      settingsWindowUrl("/settings/providers?machine=local&instanceId=codex#models", origin),
    ).toBe(`${origin}/settings/providers?machine=local&instanceId=codex#models`);
    for (const path of [
      "//evil.test/settings",
      "/\\evil.test/settings",
      "https://evil.test/settings",
      "/settings/../../api",
      "/settings-other",
      "/api/auth/session",
      null,
    ])
      expect(() => settingsWindowUrl(path, origin)).toThrow("Invalid settings window path.");
  });
  it("accepts only an explicit loopback startup URL", () => {
    expect(
      backendOriginFromOutput("[info] Local URL: http://127.0.0.1:3773\nLogin mode: local"),
    ).toBe("http://127.0.0.1:3773");
    for (const value of [
      "https://example.com",
      "http://0.0.0.0:3773",
      "http://127.0.0.1:0",
      "http://127.0.0.1:65536",
      "http://127.0.0.1:3773.evil.test",
      "http://127.0.0.1:3773/path",
    ]) {
      expect(backendOriginFromOutput(`Local URL: ${value}`)).toBeUndefined();
    }
  });

  it("keeps renderer navigation on the owned backend", () => {
    const origin = "http://127.0.0.1:3773";
    expect(isBackendNavigation(`${origin}/projects?thread=1`, origin)).toBe(true);
    for (const target of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://example.com",
      "http://127.0.0.1:3774",
      "http://user:password@127.0.0.1:3773",
    ]) {
      expect(isBackendNavigation(target, origin)).toBe(false);
    }
  });

  it("allows browser links but rejects OS commands and local files", () => {
    expect(isExternalNavigation("https://example.com/login")).toBe(true);
    expect(isExternalNavigation("mailto:help@example.com")).toBe(true);
    for (const target of [
      "file:///C:/Windows/System32/cmd.exe",
      "javascript:alert(1)",
      "ms-settings:privacy",
      "data:text/html,test",
      "https://user:password@example.com",
      "not a URL",
    ]) {
      expect(isExternalNavigation(target)).toBe(false);
    }
  });

  it("does not inherit web, authentication or Node injection overrides", () => {
    const environment = backendEnvironment({
      inherited: {
        PATH: "/usr/bin",
        COX_AUTH_PASSWORD: "secret",
        T3CODE_HOST: "0.0.0.0",
        VITE_DEV_SERVER_URL: "https://evil.test",
        NODE_OPTIONS: "--import=evil.mjs",
        NODE_PATH: "/evil",
        ELECTRON_RUN_AS_NODE: "1",
        CUSTOM_PROVIDER_KEY: "provider-key",
      },
      runtimeDirectory: "/app/runtime/bin",
      homeDirectory: "/data/desktop",
      userHome: "/user",
      platform: "darwin",
      loginPath: "/opt/homebrew/bin:/usr/bin",
    });
    expect(environment.PATH?.split(":")).toEqual([
      "/app/runtime/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/user/.local/bin",
      "/user/.npm-global/bin",
      "/usr/local/bin",
      "/bin",
    ]);
    expect(environment.COX_HOME).toBe("/data/desktop");
    expect(environment.T3CODE_HOST).toBe("127.0.0.1");
    expect(environment.CUSTOM_PROVIDER_KEY).toBe("provider-key");
    for (const name of [
      "COX_AUTH_PASSWORD",
      "VITE_DEV_SERVER_URL",
      "NODE_OPTIONS",
      "NODE_PATH",
      "ELECTRON_RUN_AS_NODE",
    ])
      expect(environment[name]).toBeUndefined();
  });

  it("allows only validated editor file deep links beside browser links", () => {
    expect(isExternalNavigation("vscode://file/workspace/file.ts:12:4")).toBe(true);
    expect(isExternalNavigation("cursor://file/workspace/file.ts")).toBe(true);
    for (const target of [
      "vscode://file",
      "vscode://file/",
      "vscode://evil.test/workspace/file.ts",
      "vscode://user:password@file/workspace/file.ts",
      "vscode-insiders://file/workspace/file.ts",
    ]) {
      expect(isExternalNavigation(target)).toBe(false);
    }
  });
  it("preserves Windows Path casing and uses the Windows separator", () => {
    const environment = backendEnvironment({
      inherited: { Path: "C:\\Windows;C:\\Tools", SystemRoot: "C:\\Windows" },
      runtimeDirectory: "C:\\Cox\\runtime",
      homeDirectory: "C:\\User\\.cox\\desktop",
      userHome: "C:\\User",
      platform: "win32",
    });
    expect(environment.Path?.startsWith("C:\\Cox\\runtime;C:\\Windows;C:\\Tools")).toBe(true);
    expect(environment.PATH).toBeUndefined();
    expect(environment.SystemRoot).toBe("C:\\Windows");
  });
});
