import { DesktopComputerToolFailure, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as DesktopComputerLink from "../../../computer/DesktopComputerLink.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const computerToolsVisible = (): boolean =>
  DesktopComputerLink.computerAvailability().enabled &&
  McpInvocationContext.hiddenFromOutsideClients();

const shared = {
  failure: Schema.Union([DesktopComputerToolFailure, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    DesktopComputerLink.DesktopComputerLink,
    ThreadManagementService.ThreadManagementService,
  ],
};

const Result = Schema.Struct({ result: Schema.Unknown });
const WindowId = Schema.String.annotate({
  description: "Window id from computer_windows.",
});
const Point = {
  window_id: WindowId,
  x: Schema.Number.annotate({
    description: "X in pixels of the latest screenshot of this window.",
  }),
  y: Schema.Number.annotate({
    description: "Y in pixels of the latest screenshot of this window.",
  }),
  frame_id: Schema.optional(
    Schema.String.annotate({ description: "frameId from that screenshot; rejects stale frames." }),
  ),
};
const BACKGROUND =
  'Input uses background delivery by default and leaves the user\'s frontmost app, focus and keyboard alone. When a `background-unavailable` failure says background input cannot reach the window (for example an app with several windows), retry with delivery:"foreground": Cox asks the user once per window and thread, then raises the window and sends the input in the foreground. A `stopped` failure means the user stopped computer control: stop and tell the user; never retry around it.';
const Delivery = Schema.optional(
  Schema.Literals(["background", "foreground"]).annotate({
    description:
      "background (default) leaves the user's focus alone; foreground asks the user once, then raises the window first. Use foreground when background input is unavailable.",
  }),
);

const StatusTool = Tool.make("computer_status", {
  ...shared,
  description:
    "Report whether macOS computer control on this Cox Desktop is ready, and which system permissions are missing.",
  parameters: Tool.EmptyParams,
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const WindowsTool = Tool.make("computer_windows", {
  ...shared,
  description:
    "List windows on the user's computer (id, app, bundleId, bundleName, title, bounds, focused). Filter by case-insensitive substring: app matches the localized app name, the bundle id or the bundle's English name.",
  parameters: Schema.Struct({
    app: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
  }),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

export const ScreenshotTool = Tool.make("computer_screenshot", {
  ...shared,
  description:
    "Capture one window by id and return the image with its frameId and pixel size. Later clicks use pixels of this image.",
  parameters: Schema.Struct({ window_id: WindowId }),
  success: Schema.Struct({
    frameId: Schema.NullOr(Schema.String),
    width: Schema.Number,
    height: Schema.Number,
    screenshot: Schema.Struct({
      mimeType: Schema.String,
      data: Schema.String,
      width: Schema.Number,
      height: Schema.Number,
    }),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const UiTreeTool = Tool.make("computer_ui_tree", {
  ...shared,
  description:
    "Read a window's accessibility tree, or query it by role, title or value. Nodes carry refs for computer_element. Prefer this over pixel input.",
  parameters: Schema.Struct({
    window_id: WindowId,
    role: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    value: Schema.optional(Schema.String),
    limit: Schema.optional(Schema.Number),
  }),
  success: Result,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const ClickTool = Tool.make("computer_click", {
  ...shared,
  description: `Click a point in a window. ${BACKGROUND}`,
  parameters: Schema.Struct({
    ...Point,
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    count: Schema.optional(Schema.Number),
    delivery: Delivery,
  }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const TypeTool = Tool.make("computer_type", {
  ...shared,
  description: `Type text into a window. ${BACKGROUND}`,
  parameters: Schema.Struct({ window_id: WindowId, text: Schema.String, delivery: Delivery }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const PressTool = Tool.make("computer_press", {
  ...shared,
  description: `Press a key chord in a window, for example ["cmd", "s"] or ["escape"]. ${BACKGROUND}`,
  parameters: Schema.Struct({
    window_id: WindowId,
    keys: Schema.Array(Schema.String),
    delivery: Delivery,
  }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const ScrollTool = Tool.make("computer_scroll", {
  ...shared,
  description: `Scroll at a point in a window; dx and dy are pixels and positive dy scrolls toward the end. ${BACKGROUND}`,
  parameters: Schema.Struct({ ...Point, dx: Schema.Number, dy: Schema.Number, delivery: Delivery }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const ElementTool = Tool.make("computer_element", {
  ...shared,
  description: `Act on an accessibility element ref from computer_ui_tree: press, click, focus, setValue or typeText. Accessibility actions work in background even when the app has several windows. A \`stopped\` failure means the user stopped computer control: stop and tell the user; never retry around it.`,
  parameters: Schema.Struct({
    ref: Schema.String,
    action: Schema.Literals(["press", "click", "focus", "setValue", "typeText"]),
    value: Schema.optional(Schema.String),
  }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

const ForegroundTool = Tool.make("computer_foreground", {
  ...shared,
  description:
    'Ask the user to allow foreground control of a window ahead of time. Explain why in reason. Cox shows the request and waits for the user\'s decision; `declined` means do not continue in the foreground. Input tools with delivery:"foreground" ask the same question themselves.',
  parameters: Schema.Struct({ window_id: WindowId, reason: Schema.String }),
  success: Result,
})
  .annotate(Tool.Destructive, true)
  .annotate(McpSchema.EnabledWhen, computerToolsVisible);

export const ComputerToolkit = Toolkit.make(
  StatusTool,
  WindowsTool,
  UiTreeTool,
  ClickTool,
  TypeTool,
  PressTool,
  ScrollTool,
  ElementTool,
  ForegroundTool,
);

export const ComputerScreenshotToolkit = Toolkit.make(ScreenshotTool);
