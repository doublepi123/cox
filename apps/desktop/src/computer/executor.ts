import { randomUUID } from "node:crypto";
import type {
  DesktopComputerAction,
  DesktopComputerPermission,
  DesktopComputerUseState,
} from "@t3tools/contracts";
import { EngineRpcError, type EngineClient } from "./engine.ts";

export function permissionState(capabilities: Record<string, unknown>, globalLive: boolean) {
  const permission = (value: unknown): "granted" | "denied" | "unknown" =>
    value === "granted"
      ? "granted"
      : value === "denied" || value === "unavailable"
        ? "denied"
        : "unknown";
  return {
    screenRecording: permission(capabilities.capturePermission),
    accessibility: permission(capabilities.axPermission),
    input:
      permission(capabilities.inputPermission) === "granted" && globalLive
        ? ("granted" as const)
        : permission(capabilities.inputPermission) === "denied" ||
            (permission(capabilities.inputPermission) === "granted" && !globalLive)
          ? ("denied" as const)
          : ("unknown" as const),
  };
}

export type ComputerExecutorOptions = {
  state(): DesktopComputerUseState;
  confirmForeground(input: {
    agent: string;
    threadTitle: string;
    windowId: string;
    reason: string;
  }): Promise<boolean>;
  showOperation(input: {
    threadId: string;
    threadTitle: string;
    agent: string;
    state: string;
    step: string;
  }): void;
  refreshState(): Promise<DesktopComputerUseState>;
  platform?: NodeJS.Platform;
  trace?(entry: ComputerTraceEntry): void;
  userIdleMs?(): number;
  wait?(ms: number): Promise<void>;
};

export const USER_PAUSE_MS = 1_000;
export const USER_PAUSE_LIMIT_MS = 30_000;
const USER_PAUSE_POLL_MS = 250;
const backgroundInput = new Set(["click", "type", "press", "scroll", "element"]);

export type ComputerKeyWindow = { app: string; pid: number | null; windowId: string } | null;

export type ComputerTraceEntry = {
  atEpochMs: number;
  threadId: string;
  agent: string;
  kind: DesktopComputerAction["kind"];
  elementAction?: string | undefined;
  role?: string | null | undefined;
  delivery?: "background" | "foreground" | undefined;
  keyWindowBefore: ComputerKeyWindow;
  keyWindowAfter: ComputerKeyWindow;
  durationMs: number;
  outcome: string;
};

const tracedKinds = new Set(["click", "type", "press", "scroll", "element", "foreground"]);

function keyWindow(windows: unknown): ComputerKeyWindow {
  if (!Array.isArray(windows)) return null;
  const focused = windows.find(
    (window): window is { id: unknown; app: unknown; pid: unknown } =>
      typeof window === "object" &&
      window !== null &&
      "focused" in window &&
      window.focused === true,
  );
  if (!focused || typeof focused.id !== "string") return null;
  return {
    app: typeof focused.app === "string" ? focused.app : "",
    pid: typeof focused.pid === "number" ? focused.pid : null,
    windowId: focused.id,
  };
}

const ELEVATED_TARGET_RECOVERY =
  "Run that app without administrator rights, or start Cox as administrator.";

const readOnly = new Set(["status", "windows", "screenshot", "uiTree"]);
const PERMISSION_RECOVERY = "Open Cox Settings → Labs → Computer control";

type CaptureFrame = {
  readonly frameId: string | null;
  readonly width: number;
  readonly height: number;
};

export function captureImage(result: unknown) {
  if (typeof result !== "object" || result === null) return undefined;
  const capture = result as {
    data?: unknown;
    mimeType?: unknown;
    width?: unknown;
    height?: unknown;
    frameId?: unknown;
  };
  if (typeof capture.data !== "string" || typeof capture.width !== "number") return undefined;
  return {
    mimeType: typeof capture.mimeType === "string" ? capture.mimeType : "image/png",
    data: capture.data,
    width: capture.width,
    height: typeof capture.height === "number" ? capture.height : 0,
    frameId: typeof capture.frameId === "string" ? capture.frameId : null,
  };
}

export function missingPermissions(state: DesktopComputerUseState) {
  return (Object.entries(state.permissions) as Array<[DesktopComputerPermission, string]>)
    .filter(([, value]) => value !== "granted")
    .map(([permission]) => permission);
}

const matches = (value: unknown, filter: string | undefined) =>
  filter === undefined ||
  (typeof value === "string" && value.toLowerCase().includes(filter.toLowerCase()));
export class ComputerExecutor {
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();
  private queues = new Map<string, Set<() => void>>();
  private frames = new Map<string, CaptureFrame>();
  private foregroundWindows = new Map<string, Set<string>>();
  private roles = new Map<string, string>();
  private activeCancels = new Map<string, () => void>();
  private resumeToken: string;
  private client: EngineClient;
  private options: ComputerExecutorOptions;
  constructor(client: EngineClient, resumeToken: string, options: ComputerExecutorOptions) {
    this.client = client;
    this.resumeToken = resumeToken;
    this.options = options;
  }
  get isStopped() {
    return this.stopped;
  }
  latchFromEngine() {
    this.stopped = true;
    for (const threadId of new Set([...this.queues.keys(), ...this.activeCancels.keys()]))
      this.cancelThread(threadId);
  }
  async stop() {
    this.latchFromEngine();
    this.foregroundWindows.clear();
    await this.client.request("stopPath.stop", { source: "host-relay" });
    this.options.showOperation({
      threadId: "",
      threadTitle: "",
      agent: "",
      state: "stopped",
      step: "",
    });
  }
  async resume() {
    await this.client.request("stopPath.resume", { token: this.resumeToken });
    this.stopped = false;
    return this.options.refreshState();
  }
  cancelThread(threadId: string) {
    this.client.cancel(threadId);
    this.activeCancels.get(threadId)?.();
    for (const cancel of this.queues.get(threadId) ?? []) cancel();
    this.queues.delete(threadId);
  }
  async threadEvent(threadId: string, state: string) {
    if (state === "cancelled" || state === "stopped") this.cancelThread(threadId);
    if (state === "waiting-model") return;
    if (this.foregroundWindows.delete(threadId) || state === "completed" || state === "failed")
      await this.client.request("control.revoke", {}).catch(() => undefined);
  }
  private delivery(threadId: string, windowId: string) {
    return this.foregroundWindows.get(threadId)?.has(windowId) ? "foreground" : "background";
  }
  execute(request: {
    threadId: string;
    threadTitle: string;
    agent: string;
    action: DesktopComputerAction;
  }) {
    return new Promise<unknown>((resolve, reject) => {
      let cancelled = false;
      const cancel = () => {
        cancelled = true;
        reject({ code: "cancelled", message: "Thread action was cancelled." });
      };
      const queue = this.queues.get(request.threadId) ?? new Set<() => void>();
      queue.add(cancel);
      this.queues.set(request.threadId, queue);
      const run = async () => {
        if (cancelled) return;
        queue.delete(cancel);
        this.activeCancels.set(request.threadId, cancel);
        if (this.stopped && !readOnly.has(request.action.kind)) {
          this.activeCancels.delete(request.threadId);
          reject({
            code: "stopped",
            message: "Computer control is stopped.",
            recovery: "Resume computer control in Cox Settings.",
          });
          return;
        }
        if (!readOnly.has(request.action.kind) && !this.options.state().ready) {
          this.activeCancels.delete(request.threadId);
          const missing = missingPermissions(this.options.state());
          reject(
            missing.length > 0
              ? {
                  code: "permission",
                  message: "Computer control is waiting for system permission.",
                  missing,
                  recovery: PERMISSION_RECOVERY,
                }
              : { code: "unavailable", message: "Computer control is not ready." },
          );
          return;
        }
        if (backgroundInput.has(request.action.kind)) {
          const paused = await this.waitForUserPause(request, () => cancelled);
          if (paused !== "ok") {
            this.activeCancels.delete(request.threadId);
            if (paused === "busy")
              reject({
                code: "background-unavailable",
                message:
                  "The user is actively using the computer, so background input was held back to avoid interrupting them. Nothing was sent; try again after they pause.",
              });
            else if (paused === "stopped")
              reject({
                code: "stopped",
                message: "Computer control is stopped.",
                recovery: "Resume computer control in Cox Settings.",
              });
            return;
          }
        }
        this.options.showOperation({
          threadId: request.threadId,
          threadTitle: request.threadTitle,
          agent: request.agent,
          state: "operating",
          step: request.action.kind,
        });
        try {
          resolve(await this.traced(request));
        } catch (error) {
          const known =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
              ? (error as {
                  code: string;
                  message?: string;
                  missing?: DesktopComputerPermission[];
                  recovery?: string;
                })
              : undefined;
          if (known && known.code !== "engine") {
            reject({ ...known, message: known.message ?? known.code });
            return;
          }
          if (
            error instanceof EngineRpcError &&
            error.code === -32000 &&
            (this.options.platform ?? process.platform) === "win32"
          ) {
            reject({
              code: "permission",
              message:
                "The target window belongs to an app running as administrator, and Windows blocks input to it from Cox.",
              recovery: ELEVATED_TARGET_RECOVERY,
            });
          } else if (
            error instanceof EngineRpcError &&
            (error.code === -32000 || error.code === -32029)
          ) {
            const state = await this.options.refreshState();
            const missing = missingPermissions(state);
            reject({
              code: "permission",
              message: error.message,
              missing:
                missing.length > 0
                  ? missing
                  : error.code === -32029
                    ? ["screenRecording"]
                    : ["accessibility"],
              recovery: PERMISSION_RECOVERY,
            });
          } else if (error instanceof EngineRpcError && error.code === -32015) {
            this.latchFromEngine();
            reject({
              code: "stopped",
              message: "The user stopped computer control.",
              recovery: "Resume computer control in Cox Settings → Labs.",
            });
          } else if (error instanceof EngineRpcError && error.code === -32003) {
            reject({ code: "background-unavailable", message: error.message });
          } else
            reject({
              code: "engine",
              message: error instanceof Error ? error.message : String(error),
            });
        } finally {
          this.activeCancels.delete(request.threadId);
        }
      };
      this.tail = this.tail.then(run, run).then(
        () => {},
        () => {},
      );
    });
  }
  async preview(windowId: string) {
    const frame = this.frames.get(windowId);
    if (!frame || frame.width === 0 || frame.height === 0) return undefined;
    const result = await this.client.request("captureRegion", {
      target: windowId,
      region: { x: 0, y: 0, width: frame.width, height: frame.height },
      ...(frame.frameId === null ? {} : { frameId: frame.frameId }),
      caps: { maxWidth: 640, maxHeight: 480 },
    });
    return captureImage(result);
  }
  private rpc<T>(threadId: string, method: string, params: unknown = {}) {
    return this.client.request<T>(method, params, 20_000, threadId);
  }
  private async waitForUserPause(
    request: { threadId: string; threadTitle: string; agent: string },
    cancelled: () => boolean,
  ): Promise<"ok" | "busy" | "stopped" | "cancelled"> {
    const idle = this.options.userIdleMs;
    if (!idle || idle() >= USER_PAUSE_MS) return "ok";
    const wait =
      this.options.wait ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.options.showOperation({
      threadId: request.threadId,
      threadTitle: request.threadTitle,
      agent: request.agent,
      state: "operating",
      step: "waiting-user",
    });
    for (let waited = 0; waited < USER_PAUSE_LIMIT_MS; waited += USER_PAUSE_POLL_MS) {
      await wait(USER_PAUSE_POLL_MS);
      if (cancelled()) return "cancelled";
      if (this.stopped) return "stopped";
      if (idle() >= USER_PAUSE_MS) return "ok";
    }
    return "busy";
  }
  private async keyWindow() {
    return keyWindow(await this.client.request("windows", {}).catch(() => null));
  }
  private async elementRole(ref: string) {
    const known = this.roles.get(ref);
    if (known !== undefined) return known;
    const node = await this.client.request<unknown>("ax.node", { ref }).catch(() => null);
    return typeof node === "object" &&
      node !== null &&
      "role" in node &&
      typeof node.role === "string"
      ? node.role
      : null;
  }
  private rememberRoles(nodes: unknown) {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes)
      if (
        typeof node === "object" &&
        node !== null &&
        "ref" in node &&
        "role" in node &&
        typeof node.ref === "string" &&
        typeof node.role === "string"
      )
        this.roles.set(node.ref, node.role);
  }
  private async traced(request: {
    threadId: string;
    threadTitle: string;
    agent: string;
    action: DesktopComputerAction;
  }) {
    const trace = this.options.trace;
    const action = request.action;
    if (!trace || !tracedKinds.has(action.kind)) return this.perform(request);
    const started = performance.now();
    const keyWindowBefore = await this.keyWindow();
    const role = action.kind === "element" ? await this.elementRole(action.ref) : undefined;
    const delivery =
      action.kind === "click" ||
      action.kind === "type" ||
      action.kind === "press" ||
      action.kind === "scroll"
        ? this.delivery(request.threadId, action.windowId)
        : undefined;
    const finish = async (outcome: string) =>
      trace({
        atEpochMs: Math.round(performance.timeOrigin + started),
        threadId: request.threadId,
        agent: request.agent,
        kind: action.kind,
        ...(action.kind === "element" ? { elementAction: action.action, role } : {}),
        ...(delivery ? { delivery } : {}),
        keyWindowBefore,
        keyWindowAfter: await this.keyWindow(),
        durationMs: Math.round(performance.now() - started),
        outcome,
      });
    try {
      const result = await this.perform(request);
      await finish("ok");
      return result;
    } catch (error) {
      await finish(
        error instanceof EngineRpcError
          ? `engine:${error.code}`
          : typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "error",
      );
      throw error;
    }
  }
  private async perform(request: {
    threadId: string;
    threadTitle: string;
    agent: string;
    action: DesktopComputerAction;
  }) {
    const action = request.action;
    if (action.kind === "status") return { state: this.options.state() };
    if (action.kind === "windows") {
      const windows = await this.rpc<unknown[]>(request.threadId, "windows", {});
      return windows.filter(
        (window) =>
          typeof window === "object" &&
          window !== null &&
          matches((window as { app?: unknown }).app, action.app) &&
          matches((window as { title?: unknown }).title, action.title),
      );
    }
    if (action.kind === "screenshot") {
      const result = await this.rpc(request.threadId, "capture", { target: action.windowId });
      const image = captureImage(result);
      if (image) this.frames.set(action.windowId, image);
      return result;
    }
    if (action.kind === "uiTree") {
      const query = {
        ...(action.role === undefined ? {} : { role: action.role }),
        ...(action.title === undefined ? {} : { title: action.title }),
        ...(action.value === undefined ? {} : { value: action.value }),
        ...(action.limit === undefined ? {} : { limit: action.limit }),
      };
      if (Object.keys(query).length === 0)
        return this.rpc(request.threadId, "ax.snapshot", { target: action.windowId });
      const nodes = await this.rpc(request.threadId, "ax.query", {
        target: action.windowId,
        query,
      });
      this.rememberRoles(nodes);
      return nodes;
    }
    if (action.kind === "foreground") {
      this.options.showOperation({
        threadId: request.threadId,
        threadTitle: request.threadTitle,
        agent: request.agent,
        state: "waiting-confirmation",
        step: action.reason,
      });
      const allowed = await this.options.confirmForeground({
        agent: request.agent,
        threadTitle: request.threadTitle,
        windowId: action.windowId,
        reason: action.reason,
      });
      if (!allowed) throw { code: "declined", message: "Foreground control was declined." };
      await this.rpc(request.threadId, "control.grant", {
        reason: action.reason,
        confirmationId: randomUUID(),
      });
      const granted = this.foregroundWindows.get(request.threadId) ?? new Set<string>();
      granted.add(action.windowId);
      this.foregroundWindows.set(request.threadId, granted);
      return this.rpc(request.threadId, "raiseWindow", { windowId: action.windowId });
    }
    const target = action.kind === "element" ? undefined : action.windowId;
    switch (action.kind) {
      case "click":
        return this.rpc(request.threadId, "click", {
          target,
          x: action.x,
          y: action.y,
          frameId: action.frameId,
          opts: {
            deliveryMode: this.delivery(request.threadId, action.windowId),
            ...(action.button ? { button: action.button } : {}),
            ...(action.count ? { count: action.count } : {}),
          },
        });
      case "type":
        return this.rpc(request.threadId, "typeText", {
          target,
          text: action.text,
          opts: { deliveryMode: this.delivery(request.threadId, action.windowId) },
        });
      case "press":
        return this.rpc(request.threadId, "keyChord", {
          target,
          keys: action.keys,
          opts: { deliveryMode: this.delivery(request.threadId, action.windowId) },
        });
      case "scroll":
        return this.rpc(request.threadId, "scroll", {
          target,
          x: action.x,
          y: action.y,
          dx: action.dx,
          dy: action.dy,
          frameId: action.frameId,
          opts: { deliveryMode: this.delivery(request.threadId, action.windowId) },
        });
      case "element": {
        const method =
          action.action === "typeText"
            ? "ax.typeText"
            : action.action === "setValue"
              ? "ax.setValue"
              : action.action === "click"
                ? "ax.click"
                : action.action === "focus"
                  ? "ax.focus"
                  : "ax.perform";
        const params =
          action.action === "typeText"
            ? { ref: action.ref, text: action.value ?? "" }
            : action.action === "setValue"
              ? { ref: action.ref, value: action.value ?? "" }
              : method === "ax.perform"
                ? { ref: action.ref, action: "press" }
                : { ref: action.ref };
        return this.rpc(request.threadId, method, params);
      }
    }
  }
}

export function initialComputerState(
  supported: boolean,
  enabled: boolean,
  engine: DesktopComputerUseState["engine"],
  permissions: DesktopComputerUseState["permissions"],
  appPath: string | null,
  macosVersion: string | null,
  stopped = false,
): DesktopComputerUseState {
  const restartRequired = false;
  const ready =
    supported &&
    enabled &&
    engine === "ready" &&
    Object.values(permissions).every((value) => value === "granted") &&
    !stopped;
  return {
    supported,
    enabled,
    engine,
    engineMessage: null,
    permissions,
    appName: "Cox",
    appPath,
    macosVersion,
    restartRequired,
    stopped,
    ready,
  };
}
