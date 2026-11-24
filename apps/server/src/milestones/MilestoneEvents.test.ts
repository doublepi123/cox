import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MilestoneHub from "./MilestoneHub.ts";

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("workflow-event-test"),
  requestNamespace: "event-test",
  thread: undefined,
  client: { sessionId: "event-test", label: "Workflow client", access: "read-only" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

it.effect.each([true, false])("lists workflow events when Workflows is set to %s", (workflowsEnabled) =>
  Effect.gen(function* () {
    yield* HttpRouter.serve(
      McpHttpServer.layerMcpTransport(McpHttpServer.layerWorkflowEvents).pipe(
        Layer.provide(ServerSettings.layerTest({ workflowsEnabled })),
        Layer.provide(MilestoneHub.layer),
        Layer.provide(Layer.mock(McpSessionRegistry.McpSessionRegistry)({ resolve: () => Effect.undefined })),
        Layer.provide(Layer.succeed(McpHttpServer.McpClientAuthenticator, { authenticate: () => Effect.succeed(scope) })),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.build);
    const http = yield* HttpClient.HttpClient;
    const call = (method: string, input: { readonly name?: string; readonly cursor?: null } = {}) =>
      http.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer outside-client",
          "mcp-method": method,
          "mcp-protocol-version": "2026-07-28",
          ...(input.name === undefined ? {} : { "mcp-name": input.name }),
        },
        body: HttpBody.jsonUnsafe({
          jsonrpc: "2.0", id: 1, method,
          params: { ...input, _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": { extensions: { "io.modelcontextprotocol/events": {} } },
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "1.0.0" },
          } },
        }),
      }).pipe(Effect.flatMap((response) => response.json));
    expect(yield* call("events/list")).toMatchObject({
      result: { events: workflowsEnabled ? expect.arrayContaining([expect.objectContaining({ name: "workflow.run_ended" })]) : [] },
    });
    const poll = yield* call("events/poll", { name: "workflow.run_ended", cursor: null });
    expect(poll).toMatchObject(workflowsEnabled ? { result: { events: [] } } : { error: expect.any(Object) });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
