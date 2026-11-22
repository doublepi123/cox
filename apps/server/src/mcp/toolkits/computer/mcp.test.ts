import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type DesktopComputerRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as DesktopComputerLink from "../../../computer/DesktopComputerLink.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const threadId = ThreadId.make("computer-mcp-thread");
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("computer-mcp-environment"),
  requestNamespace: "computer-mcp-session",
  thread: {
    threadId,
    providerSessionId: "computer-mcp-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 1,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "computer-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "computer-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const listeners = new Set<(message: unknown) => void>();
const sent: Array<unknown> = [];
const channel: DesktopComputerLink.DesktopComputerChannel = {
  send: (message) => {
    sent.push(message);
    const request = message as DesktopComputerRequest;
    if (request.type !== "cox:computer-request") return true;
    queueMicrotask(() => {
      for (const listener of listeners)
        listener(
          request.action.kind === "screenshot"
            ? {
                type: "cox:computer-reply",
                id: request.id,
                ok: true,
                result: { frameId: "f1", width: 2, height: 1 },
                image: {
                  mimeType: "image/png",
                  data: Buffer.from("png").toString("base64"),
                  width: 2,
                  height: 1,
                  frameId: "f1",
                },
              }
            : { type: "cox:computer-reply", id: request.id, ok: true, result: "typed" },
        );
    });
    return true;
  },
  subscribe: (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const layerTest = McpHttpServer.layerComputerToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(DesktopComputerLink.layerChannel(channel, 1_000)),
  Layer.provide(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const call = (name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

const enabled = (name: string) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const entry = server.tools.find(({ tool }) => tool.name === name);
    expect(entry).toBeDefined();
    const visible = Context.getOrUndefined(entry!.annotations, McpSchema.EnabledWhen);
    return visible === undefined || visible({ protocolVersion: "2025-06-18", capabilities: {} });
  });

it.effect("serves computer tools over MCP only while the desktop enables them", () =>
  Effect.gen(function* () {
    for (const listener of listeners)
      listener({ type: "cox:computer-availability", enabled: false, ready: false, missing: [] });
    expect(yield* enabled("computer_type")).toBe(false);
    for (const listener of listeners)
      listener({ type: "cox:computer-availability", enabled: true, ready: true, missing: [] });
    expect(yield* enabled("computer_type")).toBe(true);
    expect(yield* enabled("computer_screenshot")).toBe(true);
    const typed = yield* Effect.forkChild(
      call("computer_type", { window_id: "42", text: "cox line" }),
    );
    const typedResult = yield* Fiber.join(typed);
    expect(typedResult.isError).not.toBe(true);
    expect(JSON.stringify(typedResult.content)).toContain("typed");
    expect(sent).toContainEqual(
      expect.objectContaining({
        type: "cox:computer-request",
        threadId,
        agent: "codex",
        action: { kind: "type", windowId: "42", text: "cox line" },
      }),
    );
    const shot = yield* call("computer_screenshot", { window_id: "42" });
    expect(shot.isError).not.toBe(true);
    expect(shot.content.map((part) => part.type)).toEqual(["text", "image"]);
  }).pipe(Effect.provide(layerTest)),
);
