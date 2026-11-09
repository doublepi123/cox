import * as Schema from "effect/Schema";
import { DesktopUpdateProgress } from "./desktopShell.ts";

export const LocalServiceUpdateStatus = Schema.Literals([
  "unavailable",
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "restarting",
  "error",
]);

export const LocalServiceUpdateState = Schema.Struct({
  supported: Schema.Boolean,
  currentVersion: Schema.String,
  latestVersion: Schema.NullOr(Schema.String),
  status: LocalServiceUpdateStatus,
  message: Schema.NullOr(Schema.String),
  progress: Schema.NullOr(DesktopUpdateProgress),
  backup: Schema.NullOr(
    Schema.Struct({
      directory: Schema.String,
      database: Schema.String,
    }),
  ),
});
export type LocalServiceUpdateState = typeof LocalServiceUpdateState.Type;
