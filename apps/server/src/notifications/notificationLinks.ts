import { NotificationPublicBaseUrl } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ServerConfig } from "../config.ts";

const isPublicBaseUrl = Schema.is(NotificationPublicBaseUrl);

export const notificationBaseOrigin = (
  publicBaseUrl: string | null,
  config: Pick<ServerConfig["Service"], "host" | "port" | "devUrl">,
): string => {
  if (publicBaseUrl !== null && isPublicBaseUrl(publicBaseUrl)) return publicBaseUrl;
  const environmentUrl = process.env.COX_PUBLIC_BASE_URL;
  if (environmentUrl !== undefined && isPublicBaseUrl(environmentUrl)) return environmentUrl;
  if (config.devUrl !== undefined) return config.devUrl.origin;
  const host =
    config.host === undefined || ["0.0.0.0", "::", "[::]"].includes(config.host)
      ? "127.0.0.1"
      : config.host;
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${authority}:${config.port}`;
};
