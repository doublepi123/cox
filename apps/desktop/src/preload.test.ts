import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./preload.cts", import.meta.url), "utf8"),
);

function loadBridge(args: string[]) {
  const exposed = new Map<string, Record<string, unknown>>();
  const invoke = vi.fn(async () => undefined);
  runInNewContext(source, {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (name: string, bridge: Record<string, unknown>) =>
          exposed.set(name, bridge),
      },
      ipcRenderer: { invoke, on: vi.fn(), send: vi.fn(), removeListener: vi.fn() },
    }),
    process: { platform: "darwin", argv: args },
    window: { location: { protocol: "https:" } },
  });
  return { bridge: exposed.get("coxDesktop")!, exposed, invoke };
}

describe("desktop preload connection roles", () => {
  it("leaves satellite settings inline and never exposes local update privileges", async () => {
    const { bridge, exposed, invoke } = loadBridge([
      "--cox-window-kind=main",
      "--cox-remote=true",
      "--cox-inline-settings=true",
    ]);
    expect(bridge.windowKind).toBeUndefined();
    expect(bridge.openSettings).toBeTypeOf("function");
    for (const name of [
      "checkUpdates",
      "applyUpdates",
      "getBackendUpdate",
      "applyBackendUpdate",
      "getClientUpdate",
      "applyClientUpdate",
    ])
      expect(bridge[name]).toBeUndefined();
    expect(exposed.has("coxConnections")).toBe(false);
    await (bridge.openSettings as (path: string) => Promise<void>)("/settings/general");
    expect(invoke).toHaveBeenCalledWith("cox:settings-open", "/settings/general");
  });

  it("retains separate settings roles and update methods for the local primary", () => {
    const { bridge } = loadBridge(["--cox-window-kind=main"]);
    expect(bridge.windowKind).toBe("main");
    expect(bridge.checkUpdates).toBeTypeOf("function");
    expect(loadBridge(["--cox-window-kind=settings"]).bridge.windowKind).toBe("settings");
  });
});
