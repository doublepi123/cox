import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export const COMPUTER_ENGINE_RELEASE = "v5.1.81";
const repository = "https://github.com/code-yeongyu/oh-my-openagent/releases/download";
const engineName = "senpi-desktop-engine";

export type ComputerEngineArch = "arm64" | "x64";

export function computerEngineFile(platform: NodeJS.Platform) {
  return platform === "win32" ? `${engineName}.exe` : engineName;
}

export function computerEngineAsset(platform: NodeJS.Platform, arch: ComputerEngineArch) {
  return `${engineName}-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
}

export function computerStopChord(platform: NodeJS.Platform) {
  return platform === "darwin" ? "ctrl+alt+cmd+escape" : "ctrl+alt+shift+escape";
}

export function engineCachePaths(
  home: string,
  version: string,
  platform: NodeJS.Platform,
  arch: ComputerEngineArch,
) {
  const host = `${platform}-${arch}`;
  const file = computerEngineFile(platform);
  return [
    join(home, "computer-engine", version, host, file),
    join(homedir(), ".omo", "cache", engineName, version, host, file),
  ];
}

export async function acquireComputerEngine(
  destination: string,
  platform: NodeJS.Platform,
  arch: ComputerEngineArch,
): Promise<string> {
  const directory = dirname(destination);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const asset = computerEngineAsset(platform, arch);
  const base = `${repository}/${COMPUTER_ENGINE_RELEASE}`;
  const [binary, checksums] = await Promise.all([
    fetch(`${base}/${asset}`).then(async (response) => {
      if (!response.ok) throw new Error(`Engine download failed (${response.status}).`);
      return Buffer.from(await response.arrayBuffer());
    }),
    fetch(`${base}/${engineName}-checksums.txt`).then(async (response) => {
      if (!response.ok) throw new Error(`Engine checksum download failed (${response.status}).`);
      return response.text();
    }),
  ]);
  const expected = checksums
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .find(([, name]) => name === asset)?.[0];
  const actual = createHash("sha256").update(binary).digest("hex");
  if (!expected || actual !== expected)
    throw new Error("Computer engine checksum verification failed.");
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o700);
  try {
    await file.writeFile(binary);
    await file.chmod(0o755);
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
  return destination;
}

export class EngineRpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

type RpcMessage = {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export class EngineClient {
  private readonly child: ChildProcess;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly activeTags = new Map<string, number>();
  private readonly listeners = new Set<(method: string, params: unknown) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private closed = false;
  constructor(path: string, args: readonly string[] = []) {
    this.child = spawn(path, [...args, "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write(`computer engine emitted non-JSON output: ${line.slice(0, 200)}\n`);
        return;
      }
      if (typeof message === "object" && message !== null) this.receive(message as RpcMessage);
    });
    this.child.stderr?.on("data", (chunk) =>
      process.stderr.write(`computer engine: ${String(chunk)}`),
    );
    this.child.once("exit", (code, signal) =>
      this.failAll(new Error(`Computer engine exited (${code ?? signal ?? "unknown"}).`)),
    );
    this.child.once("error", (error) => this.failAll(error));
  }
  onNotification(listener: (method: string, params: unknown) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onClose(listener: (error: Error) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
  notify(method: string, params: unknown = {}) {
    if (!this.closed)
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  cancel(tag: string) {
    const id = this.activeTags.get(tag);
    if (id !== undefined) this.notify("$/cancel", { id });
  }
  request<T>(method: string, params: unknown = {}, timeoutMs = 20_000, tag?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Computer engine is closed."));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Computer engine request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      if (tag) this.activeTags.set(tag, id);
      this.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (error) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  private receive(message: RpcMessage) {
    if (message.method) {
      for (const listener of this.listeners) listener(message.method, message.params);
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    for (const [tag, id] of this.activeTags) if (id === message.id) this.activeTags.delete(tag);
    if (message.error)
      pending.reject(
        new EngineRpcError(message.error.code, message.error.message, message.error.data),
      );
    else pending.resolve(message.result);
  }
  private failAll(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener(error);
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin?.end();
    this.child.kill();
    const error = new Error("Computer engine closed.");
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

export async function openEngine(
  path: string,
  args: readonly string[] = [],
): Promise<{ client: EngineClient; resumeToken: string; capabilities: Record<string, unknown> }> {
  const client = new EngineClient(path, args);
  try {
    const hello = await client.request<{ abi: string; protocolVersion: string }>("engine.hello");
    if (hello.abi !== "senpi-desktop/1" || hello.protocolVersion !== "1")
      throw new Error("Incompatible computer engine protocol.");
    const opened = await client.request<{
      resumeToken: string;
      capabilities: Record<string, unknown>;
    }>("session.open", { showCursor: false });
    return { client, ...opened };
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function findEngine(paths: readonly string[]) {
  for (const path of paths) {
    try {
      if ((await stat(path)).isFile()) return path;
    } catch {}
  }
  return undefined;
}
