import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NotificationPublicBaseUrl = TrimmedNonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return "Notification server URL must be an HTTP(S) origin.";
    const url = new URL(value);
    return (
      ((url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/") ||
      "Notification server URL must be an HTTP(S) origin without credentials, query or fragment."
    );
  }),
);
export type NotificationPublicBaseUrl = typeof NotificationPublicBaseUrl.Type;
