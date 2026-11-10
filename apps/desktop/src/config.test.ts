import { describe, expect, it } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backendEnvironment,
  backendOriginFromOutput,
  isBackendNavigation,
  isExternalNavigation,
  settingsWindowUrl,
  usageWindowUrl,
} from "./config.ts";

describe("desktop local-only policy", () => {
  it("loads navigation policy outside the workspace without development dependencies", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-desktop-config-"));
    await using _cleanup = {
      [Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true }),
    };
    const source = await readFile(new URL("./config.ts", import.meta.url), "utf8");
    const staged = join(directory, "config.ts");
    await writeFile(staged, source);
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        "import { pathToFileURL } from 'node:url'; const config = await import(pathToFileURL(process.argv[1]).href); if (!config.isExternalNavigation('vscode://file/workspace/file.ts') || config.isExternalNavigation('vscode://evil.test/file.ts')) throw new Error('Navigation policy mismatch'); process.stdout.write('ok');",
        staged,
      ],
      { cwd: directory, encoding: "utf8" },
    );
    expect(output).toBe("ok");
  });
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

  it("restricts usage windows to the same server and preserves filters", () => {
    const origin = "https://remote.example.com";
    expect(usageWindowUrl("/usage?metric=tokens#models", origin)).toBe(
      origin + "/usage?metric=tokens#models",
    );
    for (const path of [
      "//evil.test/usage",
      "/\\evil.test/usage",
      "/settings",
      "/usage/other",
      "/usage/../api",
      "https://evil.test/usage",
      null,
    ])
      expect(() => usageWindowUrl(path, origin)).toThrow("Invalid usage window path.");
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
