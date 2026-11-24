import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
// @effect-diagnostics-next-line nodeBuiltinImport:off - Playwright download mocks perform real file operations outside the Effect runtime.
import * as NodeFSP from "node:fs/promises";
it.effect("keeps a tab's zoom when its viewer resizes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const { tabId } = yield* manager.open({
        threadId: scope.thread.threadId,
        runtime: "server",
        zoomFactor: 1.5,
      });
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const cdp = contexts[0]!.sessions[0]!;
      cdp.send.mockClear();
      // Resizing the page resets Chromium's device metrics, so zoom must be applied again.
      yield* viewer.input({ type: "resize", width: 390, height: 844 });
      expect(cdp.send).toHaveBeenCalledWith(
        "Emulation.setDeviceMetricsOverride",
        expect.objectContaining({ deviceScaleFactor: 3 }),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import {
  type BrowserRecordingFrameRate,
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

vi.mock("./ServerBrowserContexts.ts", () => {
  class FakeServerBrowserContexts {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      const setupFailure = pageSetupFailure;
      if (setupFailure) {
        context.newCDPSession = async () => {
          throw setupFailure;
        };
      }
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async scratchPage() {
      return encoderPageOverride ?? (makeEncoderPage() as unknown as Page);
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext();
      context.page.viewportSize.mockReturnValue(null);
      desktopConnections.push({ endpoint, context });
      return { browser: { close: async () => {} }, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  }
  return {
    presentAsChrome: async () => {},
    ServerBrowserContexts: vi.fn(FakeServerBrowserContexts),
  };
});

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(
  frame: ReturnType<typeof makeFrame> | undefined,
  viewport: { width: number; height: number },
) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        if ((input as { format: string }).format === "jpeg" && heldStill) await heldStill();
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        return {
          executionContextId:
            (input as { worldName?: string }).worldName === "t3-preview-viewport"
              ? 9
              : (input as { worldName?: string }).worldName === "t3-preview"
                ? 1
                : 7,
        };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      if (method === "Input.dispatchKeyEvent" && (input as { commands?: unknown }).commands) {
        if (focusedFrame) focusedFrame.copy = keyCopy || focusedFrame.copy;
        else pageCopy = keyCopy || pageCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return desktopSizeAnswer?.() ?? { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = "about:blank";
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => fileChooserElement(".csv"),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn((): unknown => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  const context = {
    page,
    sessions,
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
        cssViewport,
      );
      sessions.push(session);
      return session;
    },
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

// Runs the real encoder script against fake canvas and MediaRecorder globals.
function makeEncoderPage() {
  let paintedFrame = "";
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(bitmap: { pixels: string }) {
        paintedFrame = bitmap.pixels;
      },
      fillRect() {},
    }),
    captureStream: (frameRate?: number) => ({
      frameRate,
      getTracks: () => [],
      getVideoTracks: () => [{ requestFrame() {} }],
    }),
  };
  const video = {
    play: async () => {},
    pause() {},
    requestVideoFrameCallback: (callback: () => void) => queueMicrotask(callback),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    mimeType = "video/webm";
    state = "inactive";
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    readonly stream: { frameRate?: number };
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      this.stream = stream;
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([paintedFrame]) });
      this.onstop?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => (tag === "video" ? video : canvas) },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async (blob: Blob) => ({
      width: 1280,
      height: 800,
      pixels: await blob.text(),
      close() {},
    }),
    atob,
    btoa,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let heldStill: (() => Promise<void>) | null = null;
let encoderPageOverride: Page | undefined;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let pageSetupFailure: Error | null = null;
let initialNavigation: (() => Promise<void>) | null = null;
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopTabs = new Set<string>();
const releasedDesktopTabs: Array<string> = [];
const desktopConnections: Array<{ endpoint: string; context: ReturnType<typeof makeContext> }> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = (fixture?: { readonly executable: string; readonly baseDir: string }) =>
  Layer.mergeAll(
    Broker.layer,
    Manager.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(scope.environmentId),
      getDescriptor: Effect.die("unused descriptor"),
    }),
    Layer.succeed(PreviewBrowser.PreviewBrowser, {
      executable: fixture
        ? Effect.succeed(fixture.executable)
        : Effect.die("mock Chromium does not need an executable"),
      installed: Effect.die("mock Chromium does not need an executable"),
    }),
    PreviewAgentActivity.layer,
  ).pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), fixture?.baseDir ?? { prefix: "t3-server-browser-" }),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies()));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});
const viewerInput = (tabId: string, canOperate: boolean) => ({
  threadId: scope.thread.threadId,
  tabId,
  canOperate,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

beforeEach(() => {
  contexts.length = 0;
  encoderStreams.length = 0;
  contextRequests.length = 0;
  contextGate = null;
  heldStill = null;
  encoderPageOverride = undefined;
  contextFailure = null;
  pageSetupFailure = null;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  desktopSizeAnswer = null;
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("names the configured data directory in browser setup advice from preview_open", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "cox-preview-browser-",
    });
    const baseDir = path.join(directory, "custom Cox data");
    const executable = path.join(directory, "chrome-headless-shell");
    const actual = yield* Effect.promise(() =>
      vi.importActual<typeof import("./ServerBrowserContexts.ts")>("./ServerBrowserContexts.ts"),
    );
    vi.mocked(ServerBrowserContexts).mockImplementationOnce(actual.ServerBrowserContexts);
    const launch = vi.spyOn(chromium, "launch").mockImplementationOnce(async (options) => {
      throw new Error(
        options?.chromiumSandbox
          ? "Chromium sandboxing failed!"
          : "The browser launched without sandboxing.",
      );
    });
    vi.stubEnv("T3CODE_SERVER_BROWSER_SANDBOX", undefined);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        launch.mockRestore();
        vi.unstubAllEnvs();
      }),
    );

    const error = yield* Effect.gen(function* () {
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      return yield* broker
        .invoke<PreviewAutomationStatus>({ scope, operation: "open", input: { show: false } })
        .pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        ServerBrowser.layer.pipe(Layer.provideMerge(dependencies({ executable, baseDir }))),
      ),
      Effect.provideService(HostProcess.UserId, 1000),
    );

    expect(error._tag).toBe("PreviewAutomationExecutionError");
    expect(error.message).toContain(
      HostProcess.Platform.defaultValue() === "win32"
        ? `browser setup "--base-dir" "${baseDir}"`
        : `browser setup --base-dir '${baseDir}'`,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("preview_open reports its navigation timeout instead of the request budget", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      initialNavigation = async () => {
        throw Object.assign(new Error("page.goto: Timeout 15000ms exceeded."), {
          name: "TimeoutError",
        });
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: {
            url: "http://localhost:1337/",
            reuseExistingTab: false,
            show: false,
          },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "PreviewAutomationTimeoutError",
        timeoutMs: 15_000,
      });
      expect(error.message).toBe("Preview automation open timed out after 15000ms.");
      expect(contexts[1]?.page.isClosed()).toBe(true);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toEqual([tabId]);
      const reopened = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { show: false },
      });
      expect(reopened.tabId).toBe(tabId);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("preview_open keeps an existing tab when its navigation fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const page = contexts[0]?.page;
      page?.goto.mockRejectedValueOnce(new Error("page.goto: net::ERR_CONNECTION_REFUSED"));

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://127.0.0.1:1337/", show: false },
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("Navigation to http://127.0.0.1:1337/ failed:");
      expect(page?.isClosed()).toBe(false);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      expect(sessions.map((session) => session.tabId)).toEqual([tabId]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("returns the committed page when load readiness times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const url = "http://127.0.0.1:1337/slow";
      page.waitForLoadState.mockRejectedValueOnce(
        Object.assign(new Error("load timed out"), { name: "TimeoutError" }),
      );
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "navigate",
        input: { url, readiness: "load", timeoutMs: 1_000 },
      });
      expect(page.goto).toHaveBeenLastCalledWith(
        url,
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(status.url).toBe(url);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("preview_open keeps an initial download available when navigation rejects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const url = "http://127.0.0.1:1337/report.csv";
      const released = Promise.withResolvers<void>();
      initialNavigation = async () => {
        const page = contexts[1]?.page;
        if (!page) throw new Error("The download page was not created.");
        page.emit("download", {
          failure: async () => null,
          delete: async () => released.resolve(),
          saveAs: (path: string) => NodeFSP.writeFile(path, "a,b"),
          suggestedFilename: () => "report.csv",
          url: () => url,
        });
        throw new Error("page.goto: Download is starting");
      };

      const error = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { url, reuseExistingTab: false, show: false },
        })
        .pipe(Effect.flip);

      expect(error.message).toContain("Download is starting");
      yield* Effect.promise(() => released.promise);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      const downloadTab = sessions.find((session) => session.tabId !== tabId);
      if (!downloadTab) throw new Error("The download tab was removed.");
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId: PreviewTabId.make(downloadTab.tabId),
        operation: "status",
        input: {},
      });
      expect(status.downloads).toEqual([
        expect.objectContaining({ fileName: "report.csv", sizeBytes: 3 }),
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { method: "goto" as const, message: { type: "navigate", url: "http://10.255.255.1/" } },
  { method: "goBack" as const, message: { type: "history", delta: -1 } },
  { method: "goForward" as const, message: { type: "history", delta: 1 } },
  { method: "reload" as const, message: { type: "reload" } },
])("a pending viewer $method allows a corrected URL and text input", ({ method, message }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const started = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      const page = contexts[0]!.page;
      page[method].mockImplementationOnce(() => {
        started.resolve();
        return committed.promise;
      });
      const navigation = yield* viewer.input(message).pipe(Effect.forkScoped);
      yield* Effect.promise(() => started.promise);
      const cdp = contexts[0]!.sessions.at(-1)!;
      const send = cdp.send.getMockImplementation()!;
      const typed = Promise.withResolvers<void>();
      cdp.send.mockImplementation(async (operation, input) => {
        if (operation === "Input.insertText") typed.resolve();
        return send(operation, input);
      });
      const correction = yield* Effect.gen(function* () {
        yield* viewer.input({ type: "navigate", url: "http://localhost:5173/fixed" });
        yield* viewer.input({ type: "text", text: "hello" });
      }).pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() => Effect.sync(() => committed.resolve()));
      // The text reaches the page while the first navigation is still uncommitted.
      yield* Effect.promise(() => typed.promise);
      expect(page.goto).toHaveBeenLastCalledWith(
        "http://localhost:5173/fixed",
        expect.objectContaining({ waitUntil: "commit" }),
      );
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "hello",
      });
      committed.resolve();
      yield* Fiber.join(navigation);
      yield* Fiber.join(correction);
    }),
  ).pipe(Effect.provide(layer)),
);

// The fake encoder decodes every frame at 1280x800, so 30 fps hits the bitrate floor.
it.live.each([
  { reports: [], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [30], frameRate: 30, bitsPerSecond: 2.5e6 },
  { reports: [60], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, undefined], frameRate: 60, bitsPerSecond: 1280 * 800 * 60 * 0.05 },
  { reports: [60, 30], frameRate: 30, bitsPerSecond: 2.5e6 },
] satisfies ReadonlyArray<{
  reports: ReadonlyArray<BrowserRecordingFrameRate | undefined>;
  frameRate: number;
  bitsPerSecond: number;
}>)(
  "agent recordings encode at the last reported frame rate ($reports)",
  ({ reports, frameRate, bitsPerSecond }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const reportProfiles = yield* browser.profileReporter;
        for (const recordingFrameRate of reports) {
          yield* reportProfiles({
            profiles: [],
            defaultProfileId: "default",
            ...(recordingFrameRate === undefined ? {} : { recordingFrameRate }),
          });
        }
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        expect(encoderStreams).toEqual([{ frameRate, bitsPerSecond }]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([
  { refreshFails: false, expected: "final frame" },
  { refreshFails: true, expected: "frame" },
])(
  "saves the last page state when stopping a recording ($refreshFails)",
  ({ refreshFails, expected }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });

        const cdp = contexts[0]!.sessions[0]!;
        const send = cdp.send.getMockImplementation()!;
        cdp.send.mockImplementation((method, input) => {
          if (method !== "Page.captureScreenshot") return send(method, input);
          return refreshFails
            ? Promise.reject(new Error("Page cannot capture a frame"))
            : Promise.resolve({ data: Buffer.from("final frame").toString("base64") });
        });
        const artifact = yield* broker.invoke<{ path: string }>({
          scope,
          tabId,
          operation: "recordingStop",
          input: {},
        });
        expect(yield* fs.readFileString(artifact.path)).toBe(expected);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each([{ truncated: false }, { truncated: true }])(
  "saves a large recording as a binary download and removes its staged file (truncated: $truncated)",
  ({ truncated }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const bytes = 8 * 1024 * 1024;
        const payload = Buffer.alloc(bytes, 0x5a);
        let stagedPath: string | undefined;
        const download = Promise.withResolvers<{ saveAs: (path: string) => Promise<void> }>();
        const sandbox = NodeVM.createContext({
          __t3Recorder: {
            frame: async () => true,
            stop: async () => ({ mimeType: "video/webm", count: 1, bytes }),
            chunk: async () => {
              throw new Error("Large recording used Base64 export");
            },
            download: () =>
              download.resolve({
                saveAs: async (path) => {
                  stagedPath = path;
                  await NodeFSP.writeFile(path, truncated ? payload.subarray(1) : payload);
                },
              }),
          },
        });
        encoderPageOverride = {
          ...makeContext().page,
          evaluate: async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
            typeof script === "function"
              ? NodeVM.runInContext(`(${script.toString()})`, sandbox)(arg)
              : undefined,
          waitForEvent: () => download.promise,
        } as unknown as Page;

        yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
        const stop = broker.invoke<{ path: string; sizeBytes: number }>({
          scope,
          tabId,
          operation: "recordingStop",
          input: {},
        });
        if (truncated) {
          expect(yield* stop.pipe(Effect.flip)).toMatchObject({
            _tag: "PreviewAutomationExecutionError",
          });
        } else {
          const artifact = yield* stop;
          expect(artifact.sizeBytes).toBe(bytes);
          expect(Buffer.from(yield* fs.readFile(artifact.path)).equals(payload)).toBe(true);
        }
        expect(stagedPath).toBeDefined();
        expect(yield* fs.exists(stagedPath!)).toBe(false);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("enforces provider ownership and explicit targets when a session has multiple tabs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const foreign = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/foreign" },
        })
        .pipe(Effect.flip);
      expect(foreign).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      expect(contexts[0]!.page.goto).not.toHaveBeenCalledWith(
        "http://localhost:5173/foreign",
        expect.anything(),
      );
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope: asSession("agent-b"),
        tabId,
        operation: "snapshot",
        input: {},
      });
      const foreignEvaluate = yield* broker
        .invoke<void>({
          scope: asSession("agent-b"),
          tabId,
          operation: "evaluate",
          input: { expression: "read()" },
        })
        .pipe(Effect.flip);
      expect(foreignEvaluate).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "agentMismatch",
      });
      yield* broker.invoke({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const ambiguous = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "ambiguous()" } })
        .pipe(Effect.flip);
      expect(ambiguous).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const ambiguousStop = yield* broker
        .invoke<void>({ scope, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(ambiguousStop).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "tabRequired",
      });
      const explicitStop = yield* broker
        .invoke<void>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(explicitStop).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        cause: { _tag: "PreviewAutomationRecordingNotActiveError" },
      });
      const result = yield* broker.invoke({
        scope,
        tabId,
        operation: "evaluate",
        input: { expression: "owned()" },
      });
      expect(result).toBe("evaluated");
      expect(contexts).toHaveLength(2);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a first still that never returns does not stall the tab's later captures", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker, tabId } = yield* ready;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.useRealTimers()));
      const capturing = Promise.withResolvers<void>();
      const stuck = Promise.withResolvers<void>();
      heldStill = () => {
        heldStill = null;
        capturing.resolve();
        return stuck.promise;
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => stuck.resolve()));
      yield* browser.attachViewer(viewerInput(tabId, true));
      yield* Effect.promise(() => capturing.promise);
      const snapshotting = yield* broker
        .invoke<PreviewAutomationSnapshot>({ scope, tabId, operation: "snapshot", input: {} })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2_000));
      const snapshot = yield* Fiber.join(snapshotting);
      expect(snapshot.accessibilityTree).toContain("delete");
      const second = yield* browser.attachViewer(viewerInput(tabId, false));
      const frame = yield* Stream.fromQueue(second.output).pipe(
        Stream.filter((output) => output._tag === "frame"),
        Stream.runHead,
      );
      expect(Option.isSome(frame)).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("streams to a read-only viewer without allowing takeover, input, or viewport changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, false));
      const page = contexts[0]!.page;
      page.setViewportSize.mockClear();
      const session = contexts[0]!.sessions.at(-1)!;
      session.send.mockClear();
      for (const message of [
        { type: "takeControl" },
        { type: "key", action: "down", key: "a", text: "a" },
        { type: "resize", width: 390, height: 844 },
        { type: "viewport", setting: { _tag: "freeform", width: 390, height: 844 } },
      ])
        yield* viewer.input(message);
      expect(page.setViewportSize).not.toHaveBeenCalled();
      expect(session.send.mock.calls.some(([method]) => method.startsWith("Input."))).toBe(false);
      const outputs = yield* Stream.fromQueue(viewer.output).pipe(
        Stream.takeUntil((output) => output._tag === "frame"),
        Stream.runCollect,
      );
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "frame", data: Buffer.from("frame") }),
      );
      expect(outputs).toContainEqual(expect.objectContaining({ _tag: "viewport" }));
      expect(outputs).toContainEqual(
        expect.objectContaining({ _tag: "control", canOperate: false, controller: "agent" }),
      );
      const operator = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* operator.input({ type: "takeControl" });
      yield* operator.input({ type: "text", text: "typed" });
      yield* operator.input({ type: "resize", width: 390, height: 844 });
      expect(contexts[0]!.sessions.at(-1)!.send).toHaveBeenCalledWith("Input.insertText", {
        text: "typed",
      });
      expect(page.setViewportSize).toHaveBeenCalledWith({ width: 390, height: 844 });
      yield* operator.input({ type: "releaseControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "takeover waits for the running agent and revokes snapshot refs before returning control",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const snapshot = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const ref = /\[ref=([^\]]+)\]/.exec(String(snapshot.accessibilityTree))![1]!;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<Record<string, unknown>>();
        const session = contexts[0]!.sessions[0]!;
        session.send.mockImplementationOnce(async () => {
          started.resolve();
          return finish.promise;
        });
        const running = yield* broker
          .invoke({ scope, tabId, operation: "evaluate", input: { expression: "pending()" } })
          .pipe(Effect.forkScoped);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => finish.resolve({ result: { value: "finished" } })),
        );
        yield* Effect.promise(() => started.promise);
        const takeover = yield* viewer.input({ type: "takeControl" }).pipe(Effect.forkScoped);
        let control = yield* Queue.take(viewer.output);
        while (control._tag !== "control" || control.controller !== "you") {
          control = yield* Queue.take(viewer.output);
        }
        const rejected = yield* broker
          .invoke<void>({ scope, tabId, operation: "evaluate", input: { expression: "racing()" } })
          .pipe(Effect.flip);
        expect(rejected).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
        finish.resolve({ result: { value: "finished" } });
        expect(yield* Fiber.join(running)).toBe("finished");
        yield* Fiber.join(takeover);
        yield* viewer.input({ type: "releaseControl" });
        const stale = yield* broker
          .invoke<void>({ scope, tabId, operation: "click", input: { locator: `aria-ref=${ref}` } })
          .pipe(Effect.flip);
        expect(stale._tag).toBe("PreviewAutomationInvalidSelectorError");
        expect(contexts[0]!.page.locator).not.toHaveBeenCalled();
        expect(
          yield* broker.invoke({
            scope,
            tabId,
            operation: "evaluate",
            input: { expression: "resumed()" },
          }),
        ).toBe("evaluated");
      }),
    ).pipe(Effect.provide(layer)),
);

it.live(
  "reports a valid CSS selector that matches several elements as ambiguous, not invalid",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const strict = new Error(
          "locator.scrollIntoViewIfNeeded: Error: strict mode violation: locator('button[aria-label=\\'Permissions: Full access\\']') resolved to 2 elements:",
        );
        contexts[0]!.page.locator.mockImplementation(
          () =>
            new Proxy(
              {},
              {
                get: () => async () => {
                  throw strict;
                },
              },
            ),
        );
        const failure = yield* broker
          .invoke<void>({
            scope,
            tabId,
            operation: "click",
            input: { selector: "button[aria-label='Permissions: Full access']", timeoutMs: 1_000 },
          })
          .pipe(Effect.flip);
        expect(failure.message).not.toMatch(/invalid selector/);
        expect(failure.message).toMatch(/2 elements/);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("stops typing long text at the request's deadline and says how far it got", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      page.evaluate.mockImplementation(async () => true as never);
      let now = 1_700_000_000_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      yield* Effect.addFinalizer(() => Effect.sync(() => clock.mockRestore()));
      // Each piece of keys takes 10 seconds here: over the request's 5, under the 15-second default.
      const type = vi.fn(async (_text: string) => void (now += 10_000));
      Object.assign(page, { keyboard: { type } });
      const failure = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "type",
          input: { text: "a".repeat(200) },
          timeoutMs: 5_000,
        })
        .pipe(Effect.flip);
      expect(failure._tag).toBe("PreviewAutomationTimeoutError");
      expect(failure.message).toMatch(/after 64 of 200 characters/);
      expect(type.mock.calls).toEqual([["a".repeat(64)]]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("reports a pending dialog without evaluating the page and resolves it explicitly", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173" },
      });
      const started = Promise.withResolvers<void>();
      const resolvedEvaluation = Promise.withResolvers<Record<string, unknown>>();
      const session = contexts[0]!.sessions[0]!;
      const send = session.send.getMockImplementation()!;
      session.send.mockImplementation(async (method, input) => {
        if (method !== "Runtime.evaluate") return send(method, input);
        started.resolve();
        return resolvedEvaluation.promise;
      });
      const blockedAction = yield* broker
        .invoke({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: 'confirm("Delete row?")' },
        })
        .pipe(Effect.forkScoped);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => resolvedEvaluation.resolve({ result: { value: true } })),
      );
      yield* Effect.promise(() => started.promise);
      const dialog = {
        type: () => "confirm",
        message: () => "Delete row?",
        defaultValue: () => "",
        accept: vi.fn(async () => {
          resolvedEvaluation.resolve({ result: { value: true } });
        }),
        dismiss: vi.fn(async () => {}),
      };
      page.emit("dialog", dialog);
      page.title.mockClear();
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.dialog).toMatchObject({ type: "confirm", message: "Delete row?" });
      expect(page.title).not.toHaveBeenCalled();
      expect(dialog.dismiss).not.toHaveBeenCalled();
      const reuse = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "open",
          input: { url: "http://localhost:5173/other" },
        })
        .pipe(Effect.flip);
      expect(reuse).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "dialogPending",
      });
      expect(page.goto).toHaveBeenCalledTimes(1);
      yield* broker.invoke({ scope, tabId, operation: "dialog", input: { accept: true } });
      expect(yield* Fiber.join(blockedAction)).toBe(true);
      expect(dialog.accept).toHaveBeenCalledTimes(1);
      const resolved = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(resolved.dialog).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab opened to a file the browser cannot show reports the file to download", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({ threadId: scope.thread.threadId, runtime: "server" });
      const viewer = yield* browser.attachViewer(viewerInput(opened.tabId, true));
      const page = contexts[0]!.page;
      const pdf = "https://example.com/paper.pdf";
      const request = { url: () => pdf, method: () => "GET", isNavigationRequest: () => true };
      page.emit("requestfailed", {
        ...request,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const saved = yield* Queue.unbounded<string>();
      const written = Promise.withResolvers<void>();
      page.emit("download", {
        failure: async () => null,
        delete: async () => {
          // A new navigation during cleanup must not erase the settled download status.
          page.emit("request", {
            url: () => "https://example.com/next",
            method: () => "GET",
            isNavigationRequest: () => true,
            frame: () => page,
          });
        },
        saveAs: (path: string) => {
          Queue.offerUnsafe(saved, path);
          return written.promise;
        },
        suggestedFilename: () => "paper.pdf",
        url: () => pdf,
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(yield* Queue.take(saved), "%PDF");
      written.resolve();
      const received = [];
      let status;
      do {
        status = yield* PubSub.take(events);
        received.push(status);
      } while (
        status.type !== "navigated" ||
        status.snapshot.navStatus._tag !== "Loading" ||
        status.snapshot.navStatus.url !== "https://example.com/next"
      );
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "failed",
          url: pdf,
          download: { id: expect.any(String), fileName: "paper.pdf" },
        }),
      );
      expect((yield* Queue.clear(viewer.output)).some((item) => item._tag === "download")).toBe(
        false,
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "a late failure from a request that predates tracking leaves a newer navigation loading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const navigation = (url: string) => ({
          url: () => url,
          method: () => "GET",
          isNavigationRequest: () => true,
          frame: () => page,
          failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
        });
        page.emit("request", navigation("https://example.com/next"));
        // A popup's first request can start before the tab listens for requests.
        page.emit("requestfailed", navigation("https://example.com/first"));
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.loading).toBe(true);
      }),
    ).pipe(Effect.provide(layer)),
);

it.effect("an app link's aborted request leaves the page it was clicked on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const navigation = (url: string, redirectedFrom: unknown = null) => ({
        url: () => url,
        method: () => "GET",
        isNavigationRequest: () => true,
        redirectedFrom: () => redirectedFrom,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_ABORTED" }),
      });
      const loading = Effect.map(
        broker.invoke<PreviewAutomationStatus>({ scope, tabId, operation: "status", input: {} }),
        (status) => status.loading,
      );
      // Chromium hands the link to the OS, aborts the request and keeps the current page.
      const direct = navigation("obsidian://open?vault=notes");
      page.emit("request", direct);
      page.emit("requestfailed", direct);
      expect(yield* loading).toBe(false);

      // A page that redirects to an app link ends its navigation there; the redirect itself finished.
      const open = navigation("https://example.com/open");
      page.emit("request", open);
      expect(yield* loading).toBe(true);
      const redirected = navigation("obsidian://open?vault=notes", open);
      page.emit("request", redirected);
      page.emit("requestfailed", redirected);
      expect(yield* loading).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect("a navigation that fails while a load reads its title keeps its failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const events = yield* manager.subscribeEvents;
      const page = contexts[0]!.page;
      const heldTitle = Promise.withResolvers<string>();
      page.title.mockImplementationOnce(() => heldTitle.promise);
      yield* Effect.promise(() => page.goto("https://example.com/first"));
      const failing = {
        url: () => "https://example.com/missing",
        method: () => "GET",
        isNavigationRequest: () => true,
        frame: () => page,
        failure: () => ({ errorText: "net::ERR_NAME_NOT_RESOLVED" }),
      };
      page.emit("request", failing);
      page.emit("requestfailed", failing);
      heldTitle.resolve("Held");
      // A load at the same await depth reports after the held one, so its Success marks the end.
      page.emit("load");

      const statuses: Array<string> = [];
      while (!statuses.at(-1)?.startsWith("Success")) {
        const event = yield* PubSub.take(events);
        if (event.type === "failed" && event.tabId === tabId) {
          statuses.push(`LoadFailed ${event.url}`);
        } else if (event.type === "navigated" && event.tabId === tabId) {
          const status = event.snapshot.navStatus;
          if (status._tag === "Success") statuses.push(`Success ${status.title}`);
          else if (status._tag === "Loading") statuses.push(`Loading ${status.url}`);
        }
      }
      expect(statuses).toEqual([
        "Loading https://example.com/missing",
        "LoadFailed https://example.com/missing",
        "Success test page",
      ]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.effect.each([
  {
    name: "hover burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, (_, x) => ({
        type: "mouse",
        action: "move",
        x,
        buttons: 0,
        button: "none",
      })),
      { type: "mouse", action: "down", x: 119, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 119, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 119 },
      { type: "mousePressed", x: 119 },
      { type: "mouseReleased", x: 119 },
    ],
  },
  {
    name: "wheel burst before a click",
    inputs: [
      ...Array.from({ length: 120 }, () => ({
        type: "wheel",
        x: 100,
        y: 200,
        deltaX: 0,
        deltaY: 12,
      })),
      { type: "mouse", action: "down", x: 100, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 100, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseWheel", x: 100, y: 200, deltaX: 0, deltaY: 1440 },
      { type: "mousePressed", x: 100 },
      { type: "mouseReleased", x: 100 },
    ],
  },
  {
    name: "modifier changes and drag points",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none", modifiers: 2 },
      { type: "mouse", action: "down", x: 3, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 4, buttons: 1, button: "left" },
      { type: "mouse", action: "move", x: 5, buttons: 1, button: "left" },
      { type: "mouse", action: "up", x: 5, buttons: 0, button: "left" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1, modifiers: 0 },
      { type: "mouseMoved", x: 3, modifiers: 2 },
      { type: "mousePressed", x: 3 },
      { type: "mouseMoved", x: 4 },
      { type: "mouseMoved", x: 5 },
      { type: "mouseReleased", x: 5 },
    ],
  },
  {
    name: "wheel and keyboard boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "wheel", x: 1, deltaY: 20 },
      { type: "wheel", x: 1, deltaY: 30 },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "key", action: "down", key: "a", code: "KeyA", text: "a" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { type: "mouseWheel", deltaY: 50 },
      { type: "mouseMoved", x: 2 },
      { type: "keyDown", key: "a" },
      { type: "mouseMoved", x: 3 },
    ],
  },
  {
    name: "wheel position, modifier and direction boundaries",
    inputs: [
      { type: "wheel", x: 1, deltaX: 5, deltaY: 10 },
      { type: "wheel", x: 1, deltaX: 5, deltaY: 10 },
      { type: "wheel", x: 2, deltaY: 10 },
      { type: "wheel", x: 2, deltaY: 10, modifiers: 2 },
      { type: "wheel", x: 2, deltaY: -10, modifiers: 2 },
      { type: "wheel", x: 2, deltaY: -10, modifiers: 2 },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseWheel", x: 1, deltaX: 10, deltaY: 20, modifiers: 0 },
      { type: "mouseWheel", x: 2, deltaX: 0, deltaY: 10, modifiers: 0 },
      { type: "mouseWheel", x: 2, deltaY: 10, modifiers: 2 },
      { type: "mouseWheel", x: 2, deltaY: -20, modifiers: 2 },
    ],
  },
  {
    name: "text, navigation and resize boundaries",
    inputs: [
      { type: "mouse", action: "move", x: 1, buttons: 0, button: "none" },
      { type: "text", text: "typed" },
      { type: "mouse", action: "move", x: 2, buttons: 0, button: "none" },
      { type: "navigate", url: "http://localhost:5173/next" },
      { type: "mouse", action: "move", x: 3, buttons: 0, button: "none" },
      { type: "resize", width: 640, height: 480 },
      { type: "mouse", action: "move", x: 4, buttons: 0, button: "none" },
    ],
    expected: [
      { type: "mouseMoved", x: -1 },
      { type: "mouseMoved", x: 1 },
      { text: "typed" },
      { type: "mouseMoved", x: 2 },
      { type: "mouseMoved", x: 3 },
      { type: "mouseMoved", x: 4 },
    ],
  },
  {
    name: "ambiguous button fields",
    inputs: [
      { type: "mouse", action: "move", x: 1, button: "none" },
      { type: "mouse", action: "move", x: 2, button: "none" },
      { type: "mouse", action: "move", x: 3, buttons: 0 },
      { type: "mouse", action: "move", x: 4, buttons: 0 },
    ],
    expected: [-1, 1, 2, 3, 4].map((x) => ({ type: "mouseMoved", x })),
  },
])("orders streamed input correctly for $name", (testCase) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const session = contexts[0]!.sessions.at(-1)!;
      const send = session.send.getMockImplementation()!;
      const started = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      yield* Effect.addFinalizer(() => Effect.sync(() => finish.resolve()));
      session.send.mockClear();
      session.send.mockImplementationOnce(async (method, input) => {
        started.resolve();
        await finish.promise;
        return send(method, input);
      });
      const running = yield* viewer
        .input({ type: "mouse", action: "move", x: -1, button: "none", buttons: 0 })
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Effect.promise(() => started.promise);
      const waiting = yield* Effect.forEach(testCase.inputs, (input) =>
        viewer.input(input).pipe(Effect.forkScoped({ startImmediately: true })),
      );
      finish.resolve();
      yield* Effect.forEach([running, ...waiting], Fiber.join);
      const dispatched = session.send.mock.calls.flatMap(([method, input]) =>
        method.startsWith("Input.") ? [input] : [],
      );
      expect(dispatched).toHaveLength(testCase.expected.length);
      expect(dispatched).toMatchObject(testCase.expected);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the controlling viewer's copy and cut keys reach its clipboard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const watcher = yield* browser.attachViewer(viewerInput(tabId, false));
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const clipboard = (queue: typeof viewer.output) =>
        Queue.clear(queue).pipe(
          Effect.map((items) => items.filter((item) => item._tag === "clipboard")),
        );
      pageCopy = "unprompted";
      yield* viewer.input({ type: "mouse", action: "move", x: 10, y: 10 });
      yield* viewer.input({ type: "wheel", x: 10, y: 10, deltaY: 40 });
      yield* viewer.input({ type: "key", action: "down", key: "v", code: "KeyV", modifiers: 4 });
      yield* viewer.input({ type: "unknown" });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      keyCopy = "copied";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      const cdp = contexts[0]!.sessions.at(-1)!;
      expect(cdp.send).toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.objectContaining({ key: "c", commands: ["copy"] }),
      );
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "copied" }]);
      keyCopy = "cut";
      yield* viewer.input({ type: "key", action: "down", key: "x", code: "KeyX", modifiers: 2 });
      expect(yield* clipboard(viewer.output)).toEqual([{ _tag: "clipboard", text: "cut" }]);
      pageCopy = "left over";
      keyCopy = "";
      yield* viewer.input({ type: "key", action: "down", key: "c", code: "KeyC", modifiers: 4 });
      expect(yield* clipboard(viewer.output)).toEqual([]);
      expect(yield* clipboard(watcher.output)).toEqual([]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([false, true])(
  "a page download is saved, offered to the controller, and listed for the agent (delete fails: %s)",
  (deleteFails) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, broker, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        yield* Queue.clear(viewer.output);
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        const released = Promise.withResolvers<void>();
        page.emit("download", {
          failure: async () => null,
          delete: async () => {
            try {
              if (deleteFails) throw new Error("context closed");
              await NodeFSP.rm(original);
            } finally {
              released.resolve();
            }
          },
          saveAs: (path: string) => NodeFSP.copyFile(original, path),
          suggestedFilename: () => "report.csv",
          url: () => 'data:text/csv;charset="a,b",a b\'c',
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "download") offered = yield* Queue.take(viewer.output);
        expect(offered).toMatchObject({ _tag: "download", fileName: "report.csv", sizeBytes: 3 });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(deleteFails);
        const file = yield* browser.openDownload({
          threadId: scope.thread.threadId,
          tabId,
          downloadId: offered.id,
        });
        expect(Option.isSome(file) && file.value.fileName).toBe("report.csv");
        expect(yield* fs.readFileString(Option.getOrThrow(file).path)).toBe("a,b");
        if ((yield* HostProcess.Platform) !== "win32") {
          expect((yield* fs.stat(Option.getOrThrow(file).path)).mode & 0o777).toBe(0o600);
        }
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([
          expect.objectContaining({
            fileName: "report.csv",
            sizeBytes: 3,
            url: "data:text/csv,…",
          }),
        ]);
        expect(
          Option.isNone(
            yield* browser.openDownload({
              threadId: scope.thread.threadId,
              tabId,
              downloadId: "guess",
            }),
          ),
        ).toBe(true);
        if ((yield* HostProcess.Platform) !== "win32") {
          const folder = (yield* Path.Path).dirname(Option.getOrThrow(file).path);
          yield* fs.chmod(folder, 0o755);
          page.emit("download", {
            failure: async () => null,
            delete: async () => {},
            saveAs: (path: string) => NodeFSP.writeFile(path, "c"),
            suggestedFilename: () => "again.csv",
            url: () => "https://example.test/again.csv",
          });
          let again = yield* Queue.take(viewer.output);
          while (again._tag !== "download") again = yield* Queue.take(viewer.output);
          expect((yield* fs.stat(folder)).mode & 0o777).toBe(0o700);
        }
      }),
    ).pipe(Effect.provide(layer)),
);

it.live.each(["save failed", "oversized"])(
  "a rejected download releases the original and keeps no saved copy (%s)",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { broker, tabId } = yield* ready;
        const fs = yield* FileSystem.FileSystem;
        const original = `${yield* fs.makeTempDirectoryScoped()}/chromium-download`;
        yield* fs.writeFileString(original, "a,b");
        let savedPath: string | undefined;
        const released = Promise.withResolvers<void>();
        contexts[0]!.page.emit("download", {
          failure: async () => null,
          delete: async () => {
            await NodeFSP.rm(original);
            released.resolve();
          },
          saveAs: async (path: string) => {
            savedPath = path;
            await NodeFSP.copyFile(original, path);
            if (outcome === "save failed") throw new Error("save interrupted");
            // A sparse file exercises the size limit without writing a GiB of data.
            await NodeFSP.truncate(path, 1024 ** 3 + 1);
          },
          suggestedFilename: () => "report.csv",
          url: () => "blob:http://localhost:5173/1",
        });
        yield* Effect.promise(() => released.promise);
        expect(yield* fs.exists(original)).toBe(false);
        if (savedPath !== undefined) expect(yield* fs.exists(savedPath)).toBe(false);
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
        });
        expect(status.downloads).toEqual([]);
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a restarted server removes the previous run's downloads and keeps its profiles", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const previousTab = path.join(stateDir, "server-browser", "downloads", "previous-tab");
      const profile = path.join(stateDir, "server-browser", "profiles", "default");
      yield* fs.makeDirectory(previousTab, { recursive: true });
      yield* fs.makeDirectory(profile, { recursive: true });
      yield* fs.writeFileString(path.join(previousTab, "report.csv"), "a,b");
      yield* fs.writeFileString(path.join(profile, "Preferences"), "{}");

      yield* Layer.build(ServerBrowser.layer);

      expect(yield* fs.exists(previousTab)).toBe(false);
      expect(yield* fs.readFileString(path.join(profile, "Preferences"))).toBe("{}");
    }),
  ).pipe(Effect.provide(dependencies())),
);

it.live("a page's file picker goes to the controller and takes its uploaded files", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles,
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);
      expect(offered).toMatchObject({ multiple: false, accept: ".csv" });
      const file = (name: string) => ({ name, mimeType: "text/csv", buffer: Buffer.from(name) });
      const answer = (chooserId: string) =>
        browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId,
          files: [file("a.csv"), file("b.csv")],
        });
      expect(yield* answer("other")).toBe(false);
      expect(yield* answer(offered.id)).toBe(true);
      expect(setFiles).toHaveBeenCalledExactlyOnceWith([file("a.csv")]);
      let closed = yield* Queue.take(viewer.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
      expect(closed.id).toBe(offered.id);
      expect(yield* answer(offered.id)).toBe(false);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("overlapping file pickers keep the newer offer answerable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const firstFiles = vi.fn(async (_files: unknown) => {});
      const secondFiles = vi.fn(async (_files: unknown) => {});
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({ ...fileChooserElement(""), getAttribute: () => accept.promise }),
        setFiles: firstFiles,
      });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(".csv"),
        setFiles: secondFiles,
      });
      accept.resolve(".txt");
      let first = yield* Queue.take(viewer.output);
      while (first._tag !== "fileChooser") first = yield* Queue.take(viewer.output);
      let second = yield* Queue.take(viewer.output);
      while (second._tag !== "fileChooser") second = yield* Queue.take(viewer.output);
      expect(second.accept).toBe(".csv");
      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: second.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
      expect(firstFiles).not.toHaveBeenCalled();
      expect(secondFiles).toHaveBeenCalledOnce();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a detached file picker stays open across same-document navigation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const pageDocument = {};
      vi.stubGlobal("document", pageDocument);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllGlobals()));
      const detachedInput = { isConnected: false, ownerDocument: pageDocument };
      const navigationProbe = Promise.withResolvers<boolean>();
      const navigationProbeStarted = Promise.withResolvers<void>();
      const navigationProbeFinished = Promise.withResolvers<void>();
      let probeCount = 0;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: (probe: (element: typeof detachedInput) => boolean) => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(probe(detachedInput));
            navigationProbeStarted.resolve();
            return navigationProbe.promise.then((current) => {
              const result = probe(detachedInput);
              navigationProbeFinished.resolve();
              return current && result;
            });
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(viewer.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => navigationProbeStarted.promise);
      navigationProbe.resolve(true);
      yield* Effect.promise(() => navigationProbeFinished.promise);
      yield* viewer.input({ type: "releaseControl" });
      let closedAfterNavigation = false;
      let control = yield* Queue.take(viewer.output);
      while (control._tag !== "control" || control.controller === "you") {
        if (control._tag === "fileChooserClosed") closedAfterNavigation = true;
        control = yield* Queue.take(viewer.output);
      }
      expect(closedAfterNavigation).toBe(false);
      yield* viewer.input({ type: "takeControl" });
      let restoredControl = yield* Queue.take(viewer.output);
      while (restoredControl._tag !== "control" || restoredControl.controller !== "you") {
        restoredControl = yield* Queue.take(viewer.output);
      }

      expect(
        yield* browser.answerFileChooser({
          threadId: scope.thread.threadId,
          tabId,
          chooserId: offered.id,
          files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
        }),
      ).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each(["main", "iframe"])(
  "a file picker closes at %s document commit before DOMContentLoaded",
  (frame) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { browser, tabId } = yield* ready;
        const page = contexts[0]!.page;
        const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
        yield* viewer.input({ type: "takeControl" });
        const setFiles = vi.fn(async (_files: unknown) => {});
        const probeStarted = Promise.withResolvers<void>();
        const probeSettled = Promise.withResolvers<void>();
        let probeCount = 0;
        page.emit("filechooser", {
          isMultiple: () => false,
          element: () => ({
            getAttribute: async () => "",
            evaluate: () => {
              probeCount++;
              if (probeCount === 1) return Promise.resolve(true);
              probeStarted.resolve();
              return Promise.reject(new Error("Execution context was destroyed")).finally(() =>
                probeSettled.resolve(),
              );
            },
          }),
          setFiles,
        });
        let offered = yield* Queue.take(viewer.output);
        while (offered._tag !== "fileChooser") offered = yield* Queue.take(viewer.output);

        page.emit("framenavigated", frame === "main" ? page : makeFrame());
        yield* Effect.promise(() => probeStarted.promise);
        yield* Effect.promise(() => probeSettled.promise);
        let closed = yield* Queue.take(viewer.output);
        while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(viewer.output);
        expect(closed.id).toBe(offered.id);
        expect(
          yield* browser.answerFileChooser({
            threadId: scope.thread.threadId,
            tabId,
            chooserId: offered.id,
            files: [{ name: "a.csv", mimeType: "text/csv", buffer: Buffer.from("a") }],
          }),
        ).toBe(false);
        expect(setFiles).not.toHaveBeenCalled();
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("a file picker closes when its page is replaced while control changes hands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      let probeCount = 0;
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: async () => "",
          evaluate: () => {
            probeCount++;
            if (probeCount === 1) return Promise.resolve(true);
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);

      page.emit("framenavigated", page);
      yield* Effect.promise(() => probeStarted.promise);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      let reoffered = yield* Queue.take(second.output);
      while (reoffered._tag !== "fileChooser") reoffered = yield* Queue.take(second.output);
      current.resolve(false);
      let closed = yield* Queue.take(second.output);
      while (closed._tag !== "fileChooserClosed") closed = yield* Queue.take(second.output);
      expect(closed.id).toBe(reoffered.id);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a file picker is not offered after its document changes while reading accept", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const page = contexts[0]!.page;
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* viewer.input({ type: "takeControl" });
      const accept = Promise.withResolvers<string | null>();
      const acceptRead = Promise.withResolvers<void>();
      const current = Promise.withResolvers<boolean>();
      const probeStarted = Promise.withResolvers<void>();
      page.emit("filechooser", {
        isMultiple: () => false,
        element: () => ({
          getAttribute: () => {
            acceptRead.resolve();
            return accept.promise;
          },
          evaluate: () => {
            probeStarted.resolve();
            return current.promise;
          },
        }),
        setFiles: vi.fn(async (_files: unknown) => {}),
      });

      yield* Effect.promise(() => acceptRead.promise);
      page.emit("framenavigated", page);
      accept.resolve("");
      yield* Effect.promise(() => accept.promise);
      yield* Effect.promise(() => probeStarted.promise);
      current.resolve(false);
      yield* Effect.promise(() => current.promise);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.fileChooser).toBeNull();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("only the current controller can answer a file picker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, tabId } = yield* ready;
      const first = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "takeControl" });
      const setFiles = vi.fn(async (_files: unknown) => {});
      contexts[0]!.page.emit("filechooser", {
        isMultiple: () => false,
        element: () => fileChooserElement(""),
        setFiles,
      });
      let offered = yield* Queue.take(first.output);
      while (offered._tag !== "fileChooser") offered = yield* Queue.take(first.output);
      const second = yield* browser.attachViewer(viewerInput(tabId, true));
      yield* first.input({ type: "releaseControl" });
      yield* second.input({ type: "takeControl" });
      const answered = yield* browser.answerFileChooser({
        threadId: scope.thread.threadId,
        tabId,
        chooserId: offered.id,
        files: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("a") }],
      });
      expect(answered).toBe(false);
      expect(setFiles).not.toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("agents read a human's tab with no arguments and act on it only while nobody drives", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const opened = yield* manager.open({
        threadId: scope.thread.threadId,
        url: "http://localhost:5173/mine",
        runtime: "server",
      });
      const tabId = PreviewTabId.make(opened.tabId);
      const viewer = yield* browser.attachViewer(viewerInput(tabId, true));
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status).toMatchObject({
        tabId,
        control: { owner: "human", ownedByCaller: false },
      });
      expect(status.tabs).toEqual([
        expect.objectContaining({ tabId, owner: "human", ownedByCaller: false, visible: true }),
      ]);
      const evaluated = yield* broker
        .invoke<void>({ scope, operation: "evaluate", input: { expression: "read()" } })
        .pipe(Effect.flip);
      expect(evaluated).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const refused = yield* broker
        .invoke<void>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "http://localhost:5173/agent" },
        })
        .pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "PreviewAutomationControlInterruptedError",
        reason: "humanControl",
      });
      yield* viewer.input({ type: "releaseControl" });
      const released = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(released.control).toMatchObject({ owner: "unclaimed", ownedByCaller: false });
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "http://localhost:5173/agent" },
      });
      expect(contexts[0]!.page.goto).toHaveBeenCalledWith(
        "http://localhost:5173/agent",
        expect.anything(),
      );
      yield* viewer.input({ type: "takeControl" });
      const retaken = yield* broker
        .invoke<void>({ scope, tabId, operation: "press", input: { key: "Enter" } })
        .pipe(Effect.flip);
      expect(retaken).toMatchObject({ reason: "humanControl" });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a session's own tab stays its default while other sessions' tabs are listed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const other = yield* broker.invoke<PreviewAutomationStatus>({
        scope: asSession("agent-b"),
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabId).toBe(tabId);
      expect(status.tabs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ tabId, owner: "agent", ownedByCaller: true }),
          expect.objectContaining({ tabId: other.tabId, owner: "agent", ownedByCaller: false }),
        ]),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live(
  "preview_open picks a reported profile by id or name and defaults to the reported one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const manager = yield* Manager.PreviewManager;
        yield* Effect.yieldNow;
        const reportProfiles = yield* browser.profileReporter;
        yield* reportProfiles({
          profiles: [{ id: "profile-work", name: "Work", kind: "persistent" }],
          defaultProfileId: "profile-work",
        });
        const openWith = (profileId?: string) =>
          broker.invoke<PreviewAutomationStatus>({
            scope,
            operation: "open",
            input: {
              reuseExistingTab: false,
              show: false,
              ...(profileId === undefined ? {} : { profileId }),
            },
          });
        const byDefault = yield* openWith();
        const byName = yield* openWith("WORK");
        const byId = yield* openWith("incognito");
        const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
        const profileOf = (tabId: string | null) =>
          sessions.find((session) => session.tabId === tabId)?.profileId;
        expect(profileOf(byDefault.tabId)).toBe("profile-work");
        expect(profileOf(byName.tabId)).toBe("profile-work");
        expect(profileOf(byId.tabId)).toBe("incognito");
        expect(contextRequests).toEqual([
          { profileId: "profile-work", isolated: false },
          { profileId: "profile-work", isolated: false },
          { profileId: "incognito", isolated: true },
        ]);
        expect(byDefault).toMatchObject({
          defaultProfileId: "profile-work",
          profiles: [
            { id: "default", name: "Default" },
            { id: "incognito", name: "Incognito", incognito: true },
            { id: "profile-work", name: "Work" },
          ],
        });
        const unknown = yield* openWith("Personal").pipe(Effect.flip);
        expect(unknown).toMatchObject({
          _tag: "PreviewAutomationExecutionError",
          reason:
            'No browser profile is named "Personal". Use one of: Default (id default), Incognito (id incognito), Work (id profile-work).',
        });
      }),
    ).pipe(Effect.provide(layer)),
);

it.live("profiles reported by one client survive another client's report", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { browser, broker } = yield* ready;
      contextRequests.length = 0;
      const work = { id: "profile-work", name: "Work", kind: "persistent" } as const;
      const shared = { id: "profile-shared", name: "Shared", kind: "persistent" } as const;
      const openWork = () =>
        broker.invoke<PreviewAutomationStatus>({
          scope,
          operation: "open",
          input: { reuseExistingTab: false, show: false, profileId: work.id },
        });
      const reportFromA = yield* browser.profileReporter;
      const clientB = yield* Scope.make();
      const reportFromB = yield* browser.profileReporter.pipe(
        Effect.provideService(Scope.Scope, clientB),
      );
      yield* reportFromA({ profiles: [work, shared], defaultProfileId: work.id });
      yield* reportFromB({ profiles: [shared], defaultProfileId: shared.id });
      expect(yield* openWork()).toMatchObject({
        defaultProfileId: shared.id,
        profiles: [
          { id: "default", name: "Default" },
          { id: "incognito", name: "Incognito", incognito: true },
          { id: work.id, name: work.name },
          { id: shared.id, name: shared.name },
        ],
      });
      expect(contextRequests).toEqual([{ profileId: work.id, isolated: false }]);
      yield* Scope.close(clientB, Exit.void);
      expect(yield* openWork()).toMatchObject({ defaultProfileId: work.id });
      yield* reportFromA({ profiles: [shared], defaultProfileId: shared.id });
      const removed = yield* openWork().pipe(Effect.flip);
      expect(removed).toMatchObject({
        _tag: "PreviewAutomationExecutionError",
        reason:
          'No browser profile is named "profile-work". Use one of: Default (id default), Incognito (id incognito), Shared (id profile-shared).',
      });
    }),
  ).pipe(Effect.provide(layer)),
);

it.live.each([
  { budget: "agent", limit: 8 },
  { budget: "server", limit: 32 },
])("opens and popups reserve the $budget budget before session creation", ({ budget, limit }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, browser, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = (target = scope) =>
        broker.invoke<PreviewAutomationStatus>({
          scope: target,
          operation: "open",
          input: { reuseExistingTab: false, show: false },
        });
      for (let index = 1; index < limit - 3; index++) {
        yield* open(budget === "agent" ? scope : asSession(`other-${Math.floor(index / 8)}`));
      }

      const sessionGate = Promise.withResolvers<void>();
      const launchGate = (contextGate = Promise.withResolvers<void>());
      const sessionStarted = Promise.withResolvers<void>();
      const realOpen = manager.open;
      const delayedOpen = vi.spyOn(manager, "open").mockImplementation((input) =>
        Effect.promise(() => {
          sessionStarted.resolve();
          return sessionGate.promise;
        }).pipe(Effect.andThen(realOpen(input))),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          sessionGate.resolve();
          launchGate.resolve();
          delayedOpen.mockRestore();
        }),
      );
      const events = yield* manager.subscribeEvents;
      const first = yield* open().pipe(Effect.result, Effect.forkScoped);
      yield* Effect.promise(() => sessionStarted.promise);
      const popup = makeContext();
      const resized = Promise.withResolvers<void>();
      const setViewportSize = popup.page.setViewportSize;
      popup.page.setViewportSize = vi.fn(async (size) => {
        await setViewportSize(size);
        if (size?.width === 900) resized.resolve();
      });
      const newCDPSession = popup.newCDPSession;
      popup.newCDPSession = async (target) => {
        await launchGate.promise;
        return newCDPSession(target);
      };
      contexts[0]!.page.emit("popup", popup.page);
      const last = yield* open().pipe(Effect.result, Effect.forkScoped);
      const overflow = yield* open().pipe(Effect.result, Effect.forkScoped);
      // The host processes this after the opens, while manager creation is blocked.
      const reused = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "open",
        input: { show: false },
      });
      expect(reused.tabId).toBe(tabId);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(
        limit - 3,
      );

      sessionGate.resolve();
      for (let count = 0; count < 3; count++) {
        let event = yield* PubSub.take(events);
        while (event.type !== "opened") event = yield* PubSub.take(events);
        yield* manager.resize({
          threadId: scope.thread.threadId,
          tabId: event.tabId,
          viewport: { _tag: "freeform", width: 900, height: 700 },
        });
      }
      // The same slots must stay reserved after publication, while pages are still opening.
      const duringLaunch = yield* open().pipe(Effect.result, Effect.forkScoped);
      const rejectedPopup = makeContext();
      contexts[0]!.page.emit("popup", rejectedPopup.page);
      yield* broker.invoke({ scope, tabId, operation: "status", input: {} });
      launchGate.resolve();

      expect((yield* Fiber.join(first))._tag).toBe("Success");
      expect((yield* Fiber.join(last))._tag).toBe("Success");
      for (const fiber of [overflow, duringLaunch]) {
        expect(yield* Fiber.join(fiber)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "PreviewAutomationControlInterruptedError", reason: "tabLimit" },
        });
      }
      yield* Effect.promise(() => resized.promise);
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      for (const session of sessions)
        yield* browser.attachViewer(viewerInput(session.tabId, false));
      expect(sessions).toHaveLength(limit);
      expect(popup.page.isClosed()).toBe(false);
      expect(rejectedPopup.page.isClosed()).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        tabId,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(limit);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("failed session and browser launches release capacity, as does closing a tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker, tabId } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const open = broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { reuseExistingTab: false, show: false },
      });
      for (let count = 1; count < 7; count++) yield* open;
      const failSession = vi
        .spyOn(manager, "open")
        .mockImplementationOnce(() => Effect.die(new Error("session creation failed")));
      yield* Effect.addFinalizer(() => Effect.sync(() => failSession.mockRestore()));
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      failSession.mockRestore();
      const events = yield* manager.subscribeEvents;
      contextFailure = new Error("Chromium launch failed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      let failedSession = yield* PubSub.take(events);
      while (failedSession.type !== "opened") failedSession = yield* PubSub.take(events);
      // A failed launch must not leave a session a viewer can relaunch past the budget.
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      contextFailure = null;
      pageSetupFailure = new Error("Target page, context or browser has been closed");
      expect(yield* open.pipe(Effect.result)).toMatchObject({ _tag: "Failure" });
      pageSetupFailure = null;
      expect(contexts.at(-1)!.close).toHaveBeenCalled();
      expect(contexts.at(-1)!.page.isClosed()).toBe(true);
      expect((yield* manager.list({ threadId: scope.thread.threadId })).sessions).toHaveLength(7);
      expect((yield* open).available).toBe(true);
      expect(yield* open.pipe(Effect.flip)).toMatchObject({ reason: "tabLimit" });
      expect(
        yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(failedSession.tabId),
            operation: "open",
            input: { show: false },
          })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "PreviewAutomationTabNotFoundError" });
      const browser = yield* ServerBrowser.ServerBrowser;
      expect(
        yield* browser.attachViewer(viewerInput(failedSession.tabId, false)).pipe(Effect.flip),
      ).toMatchObject({ _tag: "ServerBrowserTabNotFoundError" });
      yield* broker.invoke({ scope, tabId, operation: "close", input: {} });
      expect((yield* open).available).toBe(true);
      const status = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "status",
        input: {},
      });
      expect(status.tabs).toHaveLength(8);
    }),
  ).pipe(Effect.provide(layer)),
);
