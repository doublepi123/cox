// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import { spawn } from "node:child_process";
import { delimiter, dirname } from "node:path";

export function runLocalServiceCommand(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly signal?: AbortSignal;
    readonly timeout?: number;
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let failure: Error | undefined;
    const receive = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-16_384);
    };
    child.stdout.on("data", receive);
    child.stderr.on("data", receive);
    const stop = () => {
      failure ??= new Error("The Cox update command was cancelled or timed out.");
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = globalThis.setTimeout(stop, options.timeout ?? 180_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code) => {
      cleanup();
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Cox update command failed (${code}): ${output}`));
      else resolve(output);
    });
    if (options.signal?.aborted) stop();
  });
}

export function localServiceNodePath(node: string, environment: NodeJS.ProcessEnv): string {
  return dirname(node) + delimiter + (environment.PATH ?? "");
}
