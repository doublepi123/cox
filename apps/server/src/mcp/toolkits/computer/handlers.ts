import {
  DesktopComputerToolFailure,
  type DesktopComputerAction,
  type DesktopComputerPermission,
  type DesktopComputerReply,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DesktopComputerLink from "../../../computer/DesktopComputerLink.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ComputerScreenshotToolkit, ComputerToolkit } from "./tools.ts";

const PERMISSION_NAMES: Record<DesktopComputerPermission, string> = {
  screenRecording: "Screen Recording",
  accessibility: "Accessibility",
  input: "Input Monitoring",
};

export const COMPUTER_RECOVERY = "Cox Settings → Labs → Computer control";

export const describeMissing = (missing: ReadonlyArray<DesktopComputerPermission>): string =>
  missing.map((permission) => PERMISSION_NAMES[permission]).join(", ");

export const replyFailure = (
  reply: Extract<DesktopComputerReply, { readonly ok: false }>,
): DesktopComputerToolFailure => {
  const missing = reply.error.missing ?? [];
  const recovery = reply.error.recovery ?? COMPUTER_RECOVERY;
  return new DesktopComputerToolFailure({
    code: reply.error.code,
    message: [
      reply.error.message,
      missing.length > 0
        ? `Missing macOS permission: ${describeMissing(missing)}. Ask the user to grant it in ${recovery}.`
        : undefined,
    ]
      .filter((part) => part !== undefined)
      .join(" "),
    ...(missing.length > 0 ? { missing } : {}),
    recovery,
  });
};

const linkFailure = (error: DesktopComputerLink.DesktopComputerLinkError) =>
  new DesktopComputerToolFailure({
    code: "unavailable",
    message:
      error.reason === "unavailable"
        ? `Computer control is off or unavailable on this Cox Desktop. Ask the user to turn it on in ${COMPUTER_RECOVERY}.`
        : error.reason === "timeout"
          ? "Cox Desktop did not answer the computer control request in time."
          : "Cox Desktop is not connected, so computer control is unavailable.",
    recovery: COMPUTER_RECOVERY,
  });

export const run = Effect.fn("ComputerToolkit.run")(function* (action: DesktopComputerAction) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(invocation, "Computer control");
  const link = yield* DesktopComputerLink.DesktopComputerLink;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(thread.threadId as ThreadId)
    .pipe(Effect.orElseSucceed(() => null));
  const reply = yield* link
    .request({
      threadId: thread.threadId,
      threadTitle: shell?.title ?? "Cox thread",
      environmentId: invocation.environmentId,
      agent: thread.providerInstanceId,
      action,
    })
    .pipe(Effect.mapError(linkFailure));
  if (!reply.ok) return yield* replyFailure(reply);
  return reply;
});

const result = (action: DesktopComputerAction) =>
  run(action).pipe(Effect.map((reply) => ({ result: reply.result })));

export const layer = McpToolAccess.toLayer(ComputerToolkit, {
  computer_status: McpToolAccess.readsAsCaller(() => result({ kind: "status" })),
  computer_windows: McpToolAccess.readsAsCaller((input) =>
    result({
      kind: "windows",
      ...(input.app === undefined ? {} : { app: input.app }),
      ...(input.title === undefined ? {} : { title: input.title }),
    }),
  ),
  computer_ui_tree: McpToolAccess.readsAsCaller((input) =>
    result({
      kind: "uiTree",
      windowId: input.window_id,
      ...(input.role === undefined ? {} : { role: input.role }),
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.value === undefined ? {} : { value: input.value }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    }),
  ),
  computer_click: McpToolAccess.actsAsCaller((input) =>
    result({
      kind: "click",
      windowId: input.window_id,
      x: input.x,
      y: input.y,
      ...(input.frame_id === undefined ? {} : { frameId: input.frame_id }),
      ...(input.button === undefined ? {} : { button: input.button }),
      ...(input.count === undefined ? {} : { count: input.count }),
    }),
  ),
  computer_type: McpToolAccess.actsAsCaller((input) =>
    result({ kind: "type", windowId: input.window_id, text: input.text }),
  ),
  computer_press: McpToolAccess.actsAsCaller((input) =>
    result({ kind: "press", windowId: input.window_id, keys: input.keys }),
  ),
  computer_scroll: McpToolAccess.actsAsCaller((input) =>
    result({
      kind: "scroll",
      windowId: input.window_id,
      x: input.x,
      y: input.y,
      dx: input.dx,
      dy: input.dy,
      ...(input.frame_id === undefined ? {} : { frameId: input.frame_id }),
    }),
  ),
  computer_element: McpToolAccess.actsAsCaller((input) =>
    result({
      kind: "element",
      ref: input.ref,
      action: input.action,
      ...(input.value === undefined ? {} : { value: input.value }),
    }),
  ),
  computer_foreground: McpToolAccess.actsAsCaller((input) =>
    result({ kind: "foreground", windowId: input.window_id, reason: input.reason }),
  ),
});

export const layerScreenshot = McpToolAccess.toLayer(ComputerScreenshotToolkit, {
  computer_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const reply = yield* run({ kind: "screenshot", windowId: input.window_id });
      if (reply.image === undefined)
        return yield* new DesktopComputerToolFailure({
          code: "engine",
          message: "The window could not be captured.",
          recovery: COMPUTER_RECOVERY,
        });
      return {
        frameId: reply.image.frameId,
        width: reply.image.width,
        height: reply.image.height,
        screenshot: {
          mimeType: reply.image.mimeType,
          data: reply.image.data,
          width: reply.image.width,
          height: reply.image.height,
        },
      };
    }),
  ),
});
