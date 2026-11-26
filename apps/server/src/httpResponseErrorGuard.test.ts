// Exercise the raw Node HTTP boundary before Effect attaches serving handlers.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { afterEach, describe, expect, it } from "@effect/vitest";

import * as HttpResponseErrorGuard from "./httpResponseErrorGuard.ts";

const { guardHttpResponseWriteErrors } = HttpResponseErrorGuard;

const servers: NodeHttp.Server[] = [];
const requests: NodeHttp.ClientRequest[] = [];
const sockets: NodeNet.Socket[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  server.on("connection", (socket) => sockets.push(socket));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchResponse(
  port: number,
  path: string,
  upgrade = false,
  accept?: string,
): Promise<{
  statusCode: number | undefined;
  headers: NodeHttp.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get(
      {
        host: "127.0.0.1",
        port,
        path,
        agent: false,
        headers: {
          ...(accept ? { accept } : {}),
          ...(upgrade
            ? {
                connection: "Upgrade",
                upgrade: "websocket",
                "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
                "sec-websocket-version": "13",
              }
            : {}),
        },
      },
      (response) => {
        response.on("error", reject);
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () =>
          resolve({ statusCode: response.statusCode, headers: response.headers, body }),
        );
      },
    );
    requests.push(request);
    request.on("error", reject);
    request.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ statusCode: response.statusCode, headers: response.headers, body: "" });
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return fetchResponse(port, path).then((response) => response.statusCode ?? 0);
}

afterEach(async () => {
  for (const request of requests.splice(0)) {
    request.destroy();
  }
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("guardHttpResponseWriteErrors", () => {
  it("contains an upgrade socket write failure instead of crashing the process", async () => {
    const writeErrors: unknown[] = [];
    const failureObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
      failureObserved.resolve();
    });

    server.on("upgrade", (_request, socket) => {
      // Node's HTTP server no longer listens for errors on an upgraded socket.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    sockets.push(client);
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await expect(fetchStatus(port, "/")).resolves.toBe(200);
  });
});

describe("rejectRequestsUntilServing", () => {
  it("rejects early HTTP and upgrades, then hands each off to its serving handler", async () => {
    const writeErrors: unknown[] = [];
    let progress: { current: number; total: number } | null = { current: 2, total: 7 };
    const server = HttpResponseErrorGuard.rejectRequestsUntilServing(
      guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => writeErrors.push(error)),
      () => progress,
    );
    const port = await listen(server);

    const earlyHttp = await fetchResponse(port, "/");
    expect(earlyHttp.statusCode).toBe(503);
    expect(earlyHttp.headers["retry-after"]).toBe("1");

    const startup = await fetchResponse(
      port,
      "/?name=<script>alert(1)</script>",
      false,
      "text/html",
    );
    const startupHtml = startup.body;
    expect(startupHtml).toContain("Upgrading database (2 of 7)");
    expect(startupHtml).not.toContain("<script>");
    expect(startup.headers["cache-control"]).toBe("no-store");
    expect(startup.headers["content-security-policy"]).toContain("default-src 'none'");
    progress = { current: 3, total: 7 };
    const step = await fetchResponse(port, "/");
    expect(JSON.parse(step.body)).toEqual({ status: "starting", migration: progress });
    progress = null;
    const finished = await fetchResponse(port, "/");
    expect(JSON.parse(finished.body)).toEqual({ status: "starting", migration: null });
    const finishingPage = await fetchResponse(port, "/", false, "text/html");
    expect(finishingPage.body).not.toContain("Upgrading database");

    const earlyUpgrade = await fetchResponse(port, "/rpc", true);
    expect(earlyUpgrade.statusCode).toBe(503);
    expect(earlyUpgrade.headers["retry-after"]).toBe("1");

    server.on("request", (_request, response) => response.writeHead(204).end());

    const servingHttp = await fetchResponse(port, "/");
    expect(servingHttp.statusCode).toBe(204);
    expect(servingHttp.headers["retry-after"]).toBeUndefined();

    const pendingUpgrade = await fetchResponse(port, "/rpc", true);
    expect(pendingUpgrade.statusCode).toBe(503);
    expect(pendingUpgrade.headers["retry-after"]).toBe("1");

    server.on("upgrade", (_request, socket) => {
      socket.end(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });

    const servingUpgrade = await fetchResponse(port, "/rpc", true);
    expect(servingUpgrade.statusCode).toBe(101);
    expect(servingUpgrade.headers["retry-after"]).toBeUndefined();
    expect(writeErrors).toEqual([]);
  });

  it.effect(
    "rejects early requests on NodeHttpServer, which adds its own listener before listening",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* NodeHttpServer.make(
            () =>
              HttpResponseErrorGuard.rejectRequestsUntilServing(
                guardHttpResponseWriteErrors(NodeHttp.createServer()),
              ),
            { host: "127.0.0.1", port: 0 },
          );
          const port = (server.address as { readonly port: number }).port;

          const early = yield* Effect.promise(() => fetchResponse(port, "/"));
          expect(early.statusCode).toBe(503);
          expect(early.headers["retry-after"]).toBe("1");

          yield* server.serve(Effect.succeed(HttpServerResponse.empty({ status: 204 })));
          expect(yield* Effect.promise(() => fetchStatus(port, "/"))).toBe(204);
        }),
      ),
  );
});
