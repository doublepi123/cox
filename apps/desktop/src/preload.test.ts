import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { stripTypeScriptTypes } from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

const source = stripTypeScriptTypes(
  readFileSync(new URL("./preload.cts", import.meta.url), "utf8"),
);

function loadBridge(args: string[], globals: Record<string, unknown> = {}, protocol = "https:") {
  const exposed = new Map<string, Record<string, unknown>>();
  const invoke = vi.fn(async () => undefined);
  const listeners = new Map<string, (...args: unknown[]) => void>();
  runInNewContext(source, {
    require: () => ({
      contextBridge: {
        exposeInMainWorld: (name: string, bridge: Record<string, unknown>) =>
          exposed.set(name, bridge),
      },
      ipcRenderer: {
        invoke,
        on: (name: string, handler: (...args: unknown[]) => void) => listeners.set(name, handler),
        send: vi.fn(),
        removeListener: vi.fn(),
      },
    }),
    process: { platform: "darwin", argv: args },
    window: { location: { protocol } },
    ...globals,
  });
  return { bridge: exposed.get("coxDesktop")!, exposed, invoke, listeners };
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

  it("saves each checkbox change immediately without connecting or disabling the page", async () => {
    class Input {
      checked = true;
      addEventListener = vi.fn();
    }
    const choice = new Input();
    const ready = vi.fn();
    const querySelectorAll = vi.fn();
    const { invoke } = loadBridge(
      ["--cox-window-kind=main", "--cox-remote=true"],
      {
        HTMLInputElement: Input,
        document: {
          getElementById: (id: string) => (id === "cox-connection-new-window" ? choice : undefined),
          addEventListener: ready,
          querySelectorAll,
        },
      },
      "data:",
    );
    expect(invoke).not.toHaveBeenCalled();
    const onReady = ready.mock.calls.find(([name]) => name === "DOMContentLoaded")?.[1];
    expect(onReady).toBeTypeOf("function");
    onReady();
    const onChange = choice.addEventListener.mock.calls.find(([name]) => name === "change")?.[1];
    expect(onChange).toBeTypeOf("function");
    choice.checked = false;
    await onChange();
    choice.checked = true;
    await onChange();
    expect(invoke.mock.calls).toEqual([
      ["cox:connections-new-window", false],
      ["cox:connections-new-window", true],
    ]);
    expect(querySelectorAll).not.toHaveBeenCalled();
  });

  it("shows preference persistence failures without an unhandled rejection", async () => {
    class Input {
      checked = false;
      addEventListener = vi.fn();
    }
    const choice = new Input();
    const error = { hidden: true, textContent: "" };
    const ready = vi.fn();
    const { invoke } = loadBridge(
      ["--cox-window-kind=main", "--cox-remote=true"],
      {
        HTMLInputElement: Input,
        document: {
          getElementById: (id: string) =>
            id === "cox-connection-new-window"
              ? choice
              : id === "cox-connection-error"
                ? error
                : undefined,
          addEventListener: ready,
        },
      },
      "data:",
    );
    const onReady = ready.mock.calls.find(([name]) => name === "DOMContentLoaded")?.[1];
    onReady();
    invoke.mockRejectedValueOnce("Could not save connection preference");
    const onChange = choice.addEventListener.mock.calls.find(([name]) => name === "change")?.[1];
    onChange();
    await Promise.resolve();
    expect(error).toEqual({ hidden: false, textContent: "Could not save connection preference" });
  });

  it("updates retained connection cards using text rather than HTML and preserves form state", () => {
    class Card {
      readonly dataset: Record<string, string> = {};
      readonly name = { textContent: "" };
      readonly origin = { textContent: "" };
      readonly version = { textContent: "" };
      readonly buttons = [
        { dataset: {}, disabled: false },
        { dataset: {}, disabled: false },
      ];
      querySelector(selector: string) {
        return selector === "strong" ? this.name : selector === "span" ? this.origin : this.version;
      }
      querySelectorAll() {
        return this.buttons;
      }
    }
    const card = new Card();
    class Template {
      content = { firstElementChild: { cloneNode: () => card } };
    }
    const template = new Template();
    const profiles = {
      children: [] as Card[],
      dataset: { activeProfileId: "profile-1", currentLabel: "Current" },
      append: vi.fn((value: Card) => profiles.children.push(value)),
    };
    const error = { hidden: false };
    const getElementById = vi.fn((id: string) => {
      if (id === "cox-connection-profiles") return profiles;
      if (id === "cox-connection-profile") return template;
      if (id === "cox-connection-error") return error;
    });
    const { listeners, bridge, exposed } = loadBridge(
      ["--cox-window-kind=main", "--cox-remote=true"],
      {
        HTMLElement: Card,
        HTMLTemplateElement: Template,
        document: { getElementById, addEventListener: vi.fn() },
      },
      "data:",
    );
    const update = listeners.get("cox:connection-saved")!;
    const profile = {
      id: "profile-1",
      name: "<img src=x onerror=alert(1)>",
      origin: "https://cox.example.com",
      serverVersion: "0.1.60",
    };
    update(undefined, profile);
    expect(card.name.textContent).toBe(profile.name);
    expect(card.origin.textContent).toBe(profile.origin);
    expect(card.version.textContent).toBe("Cox 0.1.60 · Current");
    expect(card.buttons.every((button) => Reflect.get(button.dataset, "id") === profile.id)).toBe(
      true,
    );
    expect(error.hidden).toBe(true);
    update(undefined, { ...profile, serverVersion: "0.1.61" });
    expect(profiles.append).toHaveBeenCalledTimes(1);
    expect(card.version.textContent).toBe("Cox 0.1.61 · Current");
    expect(getElementById).not.toHaveBeenCalledWith("cox-connection-new-window");
    expect(getElementById).not.toHaveBeenCalledWith("cox-connection-name");
    expect(getElementById).not.toHaveBeenCalledWith("cox-connection-origin");
    expect(bridge.checkUpdates).toBeUndefined();
    expect(exposed.has("coxConnections")).toBe(true);
  });
});
