import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../../../config.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import { PREVIEW_FAILURE_COOLDOWN_MS } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-preview-failures");
const invocation = (threadId: string): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "preview-failure-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "preview-failure-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerTest = McpHttpServer.layerPreviewToolkit.pipe(
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(PreviewAutomationBroker.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-preview-failures-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const call = (threadId: string, name: string, args: Record<string, unknown>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(threadId)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    return { isError: result.isError === true, text: JSON.stringify(result.content) };
  });

it.effect("refuses preview calls after two failures in a row until the cooldown ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const connected = yield* Deferred.make<void>();
      const operations: string[] = [];
      let succeed = false;
      const events = yield* broker.connect({
        clientId: "preview-host",
        environmentId,
        supportedOperations: ["status", "waitFor", "dialog"],
      });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Deferred.succeed(connected, undefined);
        operations.push(event.request.operation);
        return broker.respond(
          succeed || event.request.operation === "status"
            ? {
                clientId: "preview-host",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: true,
                result:
                  event.request.operation === "status"
                    ? {
                        available: true,
                        visible: false,
                        tabId: "tab-1",
                        url: "about:blank",
                        title: "Blank",
                        loading: false,
                      }
                    : {},
              }
            : {
                clientId: "preview-host",
                connectionId: event.connectionId,
                requestId: event.request.requestId,
                ok: false,
                error: {
                  _tag: "PreviewAutomationExecutionError",
                  message: "waitFor did not match before the page settled",
                },
              },
        );
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(connected);
      const wait = { text: "Available models", timeoutMs: 1000 };

      const first = yield* call("thread-a", "preview_wait_for", wait);
      expect(first.isError).toBe(true);
      expect(first.text).not.toContain("refuses further preview calls");

      const second = yield* call("thread-a", "preview_wait_for", wait);
      expect(second.isError).toBe(true);
      expect(second.text).toContain("refuses further preview calls");
      expect(second.text).toContain("computer-use tools");

      const sent = operations.filter((operation) => operation === "waitFor").length;
      const refused = yield* call("thread-a", "preview_status", {});
      expect(refused.text).toContain("refuses further preview calls");
      expect(operations.filter((operation) => operation === "status")).toHaveLength(0);
      expect(operations.filter((operation) => operation === "waitFor")).toHaveLength(sent);

      const dialog = yield* call("thread-a", "preview_dialog", { accept: true });
      expect(dialog.text).not.toContain("refuses further preview calls");
      expect(operations).toContain("dialog");

      const other = yield* call("thread-b", "preview_status", {});
      expect(other).toMatchObject({ isError: false });

      yield* TestClock.adjust(PREVIEW_FAILURE_COOLDOWN_MS + 1);
      succeed = true;
      const afterCooldown = yield* call("thread-a", "preview_wait_for", wait);
      expect(afterCooldown.isError).toBe(false);
      const reset = yield* call("thread-a", "preview_wait_for", wait);
      expect(reset.isError).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  ),
);
