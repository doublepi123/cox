import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import * as NodePath from "node:path";
import { pathToFileURL } from "node:url";
import { loadRepoEnv } from "./lib/public-config.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const modes = ["dev", "dev:server", "dev:web"] as const;
type DevMode = (typeof modes)[number];

export function parsePort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Expected a port between 1024 and 65535, got ${JSON.stringify(value)}.`);
  }
  return port;
}

export function createDevConfig(
  mode: string = "dev",
  env: Readonly<NodeJS.ProcessEnv> = process.env,
  root: string = repoRoot,
) {
  if (!modes.includes(mode as DevMode)) throw new Error(`Unsupported development mode: ${mode}`);
  const serverPort = parsePort(env.COX_SERVER_PORT, 4773);
  const webPort = parsePort(env.COX_WEB_PORT, 5733);
  if (serverPort === webPort) throw new Error("Server and Web ports must be different.");
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    COX_HOME: NodePath.join(root, ".cox"),
    T3CODE_HOME: NodePath.join(root, ".cox"),
    COX_HOST: "127.0.0.1",
    T3CODE_HOST: "127.0.0.1",
    COX_PORT: String(serverPort),
    T3CODE_PORT: String(serverPort),
    HOST: "127.0.0.1",
    PORT: String(webPort),
    T3CODE_SINGLE_ORIGIN_DEV: "1",
    VITE_DEV_SERVER_URL: `http://127.0.0.1:${webPort}`,
    T3CODE_NO_BROWSER: "1",
    COX_TELEMETRY_ENABLED: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
  };
  for (const key of Object.keys(childEnv)) {
    if (
      /CLERK|RELAY|HOSTED_APP|T3_SERVICE_LAUNCHER|T3_BOOT_SERVICE|T3CODE_DEV_AUTH_TOKEN/.test(key)
    ) {
      delete childEnv[key];
    }
  }
  delete childEnv.VITE_HTTP_URL;
  delete childEnv.VITE_WS_URL;
  return { mode: mode as DevMode, serverPort, webPort, root, env: childEnv };
}

export const assertLocalPortAvailable = (port: number) =>
  new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is unavailable. Choose another Cox port; do not stop unrelated services.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

export async function runDev(config: ReturnType<typeof createDevConfig>): Promise<number> {
  if (config.mode !== "dev:web") await assertLocalPortAvailable(config.serverPort);
  if (config.mode !== "dev:server") await assertLocalPortAvailable(config.webPort);
  const children: ChildProcess[] = [];
  const closed: Promise<void>[] = [];
  let stop: ((exitCode: number) => void) | undefined;
  const result = new Promise<number>((resolve) => {
    stop = resolve;
  });
  let stopping = false;
  const shutdown = (exitCode: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.pid === undefined) continue;
      try {
        if (process.platform === "win32") child.kill("SIGTERM");
        else process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          console.error(error);
        }
      }
    }
    stop?.(exitCode);
  };
  const onInterrupt = () => shutdown(130);
  const onTerminate = () => shutdown(143);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onTerminate);
  const start = (command: string, args: string[], directory: string) => {
    const child = spawn(command, args, {
      cwd: NodePath.join(config.root, directory),
      env: config.env,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    children.push(child);
    closed.push(new Promise<void>((resolve) => child.once("close", () => resolve())));
    child.once("error", (error) => {
      console.error(error.message);
      shutdown(1);
    });
    child.once("exit", (code, signal) => shutdown(code ?? (signal ? 1 : 0)));
  };
  console.log(
    `[cox] Web http://127.0.0.1:${config.webPort} · API http://127.0.0.1:${config.serverPort}`,
  );
  console.log(`[cox] Isolated development state: ${config.env.COX_HOME}`);
  try {
    if (config.mode !== "dev:web") {
      start(
        process.execPath,
        [
          "--watch",
          "src/bin.ts",
          "--host",
          "127.0.0.1",
          "--port",
          String(config.serverPort),
          "--home-dir",
          config.env.COX_HOME!,
          "--no-browser",
        ],
        "apps/server",
      );
    }
    if (config.mode !== "dev:server") {
      start(
        process.platform === "win32" ? "pnpm.cmd" : "pnpm",
        [
          "exec",
          "vp",
          "dev",
          "--host",
          "127.0.0.1",
          "--port",
          String(config.webPort),
          "--strictPort",
        ],
        "apps/web",
      );
    }
    return await result;
  } finally {
    await Promise.all(closed);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length > 3)
    throw new Error("Use COX_SERVER_PORT and COX_WEB_PORT to configure ports.");
  process.exitCode = await runDev(createDevConfig(process.argv[2], loadRepoEnv()));
}
