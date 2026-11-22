import * as Schema from "effect/Schema";

export const DesktopComputerPermission = Schema.Literals([
  "screenRecording",
  "accessibility",
  "input",
]);
export type DesktopComputerPermission = typeof DesktopComputerPermission.Type;

export const DesktopComputerPermissionStatus = Schema.Literals(["granted", "denied", "unknown"]);
export type DesktopComputerPermissionStatus = typeof DesktopComputerPermissionStatus.Type;

export const DesktopComputerEngineStatus = Schema.Literals([
  "missing",
  "downloading",
  "ready",
  "error",
]);
export type DesktopComputerEngineStatus = typeof DesktopComputerEngineStatus.Type;

export const DesktopComputerUseState = Schema.Struct({
  supported: Schema.Boolean,
  enabled: Schema.Boolean,
  engine: DesktopComputerEngineStatus,
  engineMessage: Schema.NullOr(Schema.String),
  permissions: Schema.Struct({
    screenRecording: DesktopComputerPermissionStatus,
    accessibility: DesktopComputerPermissionStatus,
    input: DesktopComputerPermissionStatus,
  }),
  appName: Schema.String,
  appPath: Schema.NullOr(Schema.String),
  macosVersion: Schema.NullOr(Schema.String),
  restartRequired: Schema.Boolean,
  stopped: Schema.Boolean,
  ready: Schema.Boolean,
});
export type DesktopComputerUseState = typeof DesktopComputerUseState.Type;

export const DesktopComputerOperationState = Schema.Literals([
  "operating",
  "waiting-model",
  "waiting-confirmation",
  "completed",
  "failed",
  "stopped",
]);
export type DesktopComputerOperationState = typeof DesktopComputerOperationState.Type;

const WindowId = Schema.String;

export const DesktopComputerAction = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status") }),
  Schema.Struct({
    kind: Schema.Literal("windows"),
    app: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("screenshot"), windowId: WindowId }),
  Schema.Struct({
    kind: Schema.Literal("uiTree"),
    windowId: WindowId,
    role: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("click"),
    windowId: WindowId,
    x: Schema.Number,
    y: Schema.Number,
    frameId: Schema.optional(Schema.String),
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("type"), windowId: WindowId, text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("press"),
    windowId: WindowId,
    keys: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("scroll"),
    windowId: WindowId,
    x: Schema.Number,
    y: Schema.Number,
    dx: Schema.Number,
    dy: Schema.Number,
    frameId: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("element"),
    ref: Schema.String,
    action: Schema.Literals(["press", "click", "focus", "setValue", "typeText"]),
    value: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("foreground"),
    windowId: WindowId,
    reason: Schema.String,
  }),
]);
export type DesktopComputerAction = typeof DesktopComputerAction.Type;

export const DesktopComputerErrorCode = Schema.Literals([
  "disabled",
  "unavailable",
  "permission",
  "stopped",
  "cancelled",
  "declined",
  "background-unavailable",
  "invalid",
  "engine",
]);
export type DesktopComputerErrorCode = typeof DesktopComputerErrorCode.Type;

export const DesktopComputerError = Schema.Struct({
  code: DesktopComputerErrorCode,
  message: Schema.String,
  missing: Schema.optional(Schema.Array(DesktopComputerPermission)),
  recovery: Schema.optional(Schema.String),
});
export type DesktopComputerError = typeof DesktopComputerError.Type;

export class DesktopComputerToolFailure extends Schema.TaggedError<DesktopComputerToolFailure>()(
  "DesktopComputerToolFailure",
  {
    code: DesktopComputerErrorCode,
    message: Schema.String,
    missing: Schema.optional(Schema.Array(DesktopComputerPermission)),
    recovery: Schema.optional(Schema.String),
  },
) {}

export const DesktopComputerImage = Schema.Struct({
  mimeType: Schema.String,
  data: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  frameId: Schema.NullOr(Schema.String),
});
export type DesktopComputerImage = typeof DesktopComputerImage.Type;

export const DesktopComputerRequest = Schema.Struct({
  type: Schema.Literal("cox:computer-request"),
  id: Schema.String,
  threadId: Schema.String,
  threadTitle: Schema.String,
  environmentId: Schema.String,
  agent: Schema.String,
  action: DesktopComputerAction,
});
export type DesktopComputerRequest = typeof DesktopComputerRequest.Type;

export const DesktopComputerReply = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("cox:computer-reply"),
    id: Schema.String,
    ok: Schema.Literal(true),
    result: Schema.Unknown,
    image: Schema.optional(DesktopComputerImage),
  }),
  Schema.Struct({
    type: Schema.Literal("cox:computer-reply"),
    id: Schema.String,
    ok: Schema.Literal(false),
    error: DesktopComputerError,
  }),
]);
export type DesktopComputerReply = typeof DesktopComputerReply.Type;

export const DesktopComputerThreadEvent = Schema.Struct({
  type: Schema.Literal("cox:computer-thread"),
  threadId: Schema.String,
  state: Schema.Literals(["waiting-model", "completed", "failed", "stopped", "cancelled"]),
});
export type DesktopComputerThreadEvent = typeof DesktopComputerThreadEvent.Type;

export const DesktopComputerAvailability = Schema.Struct({
  type: Schema.Literal("cox:computer-availability"),
  enabled: Schema.Boolean,
  ready: Schema.Boolean,
  missing: Schema.Array(DesktopComputerPermission),
});
export type DesktopComputerAvailability = typeof DesktopComputerAvailability.Type;

export interface DesktopComputerBridge {
  getComputerUse?(): Promise<DesktopComputerUseState>;
  setComputerUseEnabled?(enabled: boolean): Promise<DesktopComputerUseState>;
  recheckComputerUse?(): Promise<DesktopComputerUseState>;
  openComputerUseSettings?(permission: DesktopComputerPermission): Promise<void>;
  restartForComputerUse?(): Promise<void>;
  resumeComputerUse?(): Promise<DesktopComputerUseState>;
  onComputerUse?(listener: (state: DesktopComputerUseState) => void): () => void;
}
