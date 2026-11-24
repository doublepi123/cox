import * as Effect from "effect/Effect";
import { HttpServer } from "effect/http";

import * as ServerConfig from "./config.ts";

export interface HeadlessServeAccessInfo {
  readonly connectionString: string;
  readonly loginMode: "local" | "password";
}

export const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

export const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const resolveLocalOrigin = (host: string | undefined, port: number): string => {
  const address =
    host === "::" || host === "[::]" ? "::1" : !host || isWildcardHost(host) ? "127.0.0.1" : host;
  return `http://${formatHostForUrl(address)}:${port}`;
};

export const resolveHeadlessConnectionString = resolveLocalOrigin;

const resolveListeningPort = (address: unknown, fallbackPort: number): number => {
  if (
    typeof address === "object" &&
    address !== null &&
    "port" in address &&
    typeof address.port === "number"
  ) {
    return address.port;
  }
  return fallbackPort;
};

export const formatHeadlessServeOutput = (accessInfo: HeadlessServeAccessInfo): string =>
  ["Local URL: " + accessInfo.connectionString, "Login mode: " + accessInfo.loginMode].join("\n");

export const resolveHeadlessServeAccessInfo = Effect.fn("resolveHeadlessServeAccessInfo")(
  function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const httpServer = yield* HttpServer.HttpServer;
    const connectionString = resolveHeadlessConnectionString(
      serverConfig.host,
      resolveListeningPort(httpServer.address, serverConfig.port),
    );

    return {
      connectionString,
      loginMode: serverConfig.authPassword ? "password" : "local",
    } satisfies HeadlessServeAccessInfo;
  },
);
