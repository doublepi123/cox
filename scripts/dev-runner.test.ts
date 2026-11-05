import { describe, expect, it } from "vite-plus/test";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assertLocalPortAvailable, createDevConfig, parsePort } from "./dev-runner.ts";

describe("local development configuration", () => {
  it("isolates Cox state and ignores inherited remote configuration", () => {
    const config = createDevConfig(
      "dev",
      {
        T3CODE_HOME: "/home/user/.t3",
        COX_HOME: "/home/user/.cox",
        T3CODE_HOST: "0.0.0.0",
        HOST: "0.0.0.0",
        VITE_WS_URL: "wss://remote.example/ws",
        VITE_HTTP_URL: "https://remote.example",
        T3CODE_RELAY_URL: "https://relay.example",
        VITE_CLERK_PUBLISHABLE_KEY: "unused",
        T3CODE_DEV_AUTH_TOKEN: "inherited-token",
        COX_TELEMETRY_ENABLED: "true",
        COX_AUTH_PASSWORD: "dev-password",
      },
      "/tmp/cox-checkout",
    );
    expect(config.env.COX_AUTH_PASSWORD).toBe("dev-password");
    expect(config.env.COX_HOME).toBe("/tmp/cox-checkout/.cox");
    expect(config.env.T3CODE_HOME).toBe("/tmp/cox-checkout/.cox");
    expect(config.env.HOST).toBe("127.0.0.1");
    expect(config.env.T3CODE_HOST).toBe("127.0.0.1");
    expect(config.env.VITE_DEV_SERVER_URL).toBe("http://127.0.0.1:5733");
    expect(config.env.VITE_HTTP_URL).toBeUndefined();
    expect(config.env.VITE_WS_URL).toBeUndefined();
    expect(config.env.T3CODE_RELAY_URL).toBeUndefined();
    expect(config.env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(config.env.T3CODE_DEV_AUTH_TOKEN).toBeUndefined();
    expect(config.env.COX_TELEMETRY_ENABLED).toBe("false");
  });

  it("accepts explicit local ports without overlapping listeners", () => {
    const config = createDevConfig("dev:server", { COX_SERVER_PORT: "4773", COX_WEB_PORT: "6733" });
    expect(config.serverPort).toBe(4773);
    expect(config.webPort).toBe(6733);
    expect(config.env.T3CODE_PORT).toBe("4773");
    expect(() => createDevConfig("dev", { COX_SERVER_PORT: "5733" })).toThrow("different");
    expect(() => createDevConfig("dev:desktop")).toThrow("Unsupported");
    for (const port of ["", "0", "80", "65536", "12.5", "NaN", "5733x"]) {
      expect(() => parsePort(port, 4773)).toThrow("port");
    }
  });

  it("rejects an occupied port without touching the existing listener", async () => {
    await using listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener.");
    await expect(assertLocalPortAvailable(address.port)).rejects.toThrow("unavailable");
    expect(listener.listening).toBe(true);
  });

  it("starts an isolated server and shuts down only its own process group", async () => {
    const root = await NodeFS.mkdtemp(NodePath.join(NodeOS.tmpdir(), "cox-launcher-"));
    await using callback = createHttpServer();
    const ready = new Promise<string>((resolve) => {
      callback.once("request", (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.once("end", () => {
          response.end("ready");
          resolve(body);
        });
      });
    });
    await new Promise<void>((resolve) => callback.listen(0, "127.0.0.1", resolve));
    const address = callback.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected a TCP listener.");
    await using reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const reserved = reservation.address();
    if (reserved === null || typeof reserved === "string")
      throw new Error("Expected a TCP listener.");
    await new Promise<void>((resolve, reject) =>
      reservation.close((error) => (error ? reject(error) : resolve())),
    );
    await NodeFS.mkdir(NodePath.join(root, "apps/server/src"), { recursive: true });
    await NodeFS.writeFile(
      NodePath.join(root, "apps/server/src/bin.ts"),
      `
      import { createServer } from "node:http";
      const server = createServer((request, response) => response.end("cox"));
      server.listen(Number(process.env.T3CODE_PORT), process.env.T3CODE_HOST, async () => {
        await fetch(process.env.COX_TEST_READY_URL, {
          method: "POST",
          body: JSON.stringify({ home: process.env.COX_HOME, cwd: process.cwd() }),
        });
      });
      process.once("SIGTERM", () => server.close());
    `,
    );
    const driver = NodePath.join(root, "driver.mjs");
    await NodeFS.writeFile(
      driver,
      `
      import { createDevConfig, runDev } from ${JSON.stringify(new URL("./dev-runner.ts", import.meta.url).href)};
      process.exitCode = await runDev(createDevConfig("dev:server", process.env, ${JSON.stringify(root)}));
    `,
    );
    const child = spawn(process.execPath, [driver], {
      env: {
        ...process.env,
        COX_SERVER_PORT: String(reserved.port),
        COX_WEB_PORT: String(address.port),
        COX_TEST_READY_URL: `http://127.0.0.1:${address.port}`,
      },
      stdio: "ignore",
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    try {
      const body = await Promise.race([
        ready,
        exited.then((code) => {
          throw new Error(`Launcher exited before ready: ${code}`);
        }),
      ]);
      expect(JSON.parse(body)).toEqual({
        home: NodePath.join(root, ".cox"),
        cwd: NodePath.join(root, "apps/server"),
      });
      expect(child.kill("SIGTERM")).toBe(true);
      expect(await exited).toBe(143);
      expect(callback.listening).toBe(true);
      await expect(assertLocalPortAvailable(reserved.port)).resolves.toBeUndefined();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      await NodeFS.rm(root, { recursive: true, force: true });
    }
  });
});
