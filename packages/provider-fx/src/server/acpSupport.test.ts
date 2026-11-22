import * as Layer from "effect/Layer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

import { fxPermissionDisposition, makeFxAcpRuntime } from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

const mockFx = `
const lines = require("node:readline").createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const { method, params, id } = JSON.parse(line);
  if (id === undefined) return;
  const reply = method === "initialize"
    ? { result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } }
    : params._meta?.fx?.profileMcpServers === true && params.mcpServers?.length === 1 &&
      (method === "session/new" || (method === "session/load" && params.sessionId === "resumed"))
      ? { result: { sessionId: params.sessionId ?? "created" } }
      : { error: { code: -32602, message: "Unexpected session setup: " + line } };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...reply }));
});
`;

it.effect.each([undefined, "resumed"])(
  "opts into profile MCP on FX session setup (%s)",
  (sessionId) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fileSystem.makeTempDirectoryScoped();
      yield* fileSystem.writeFileString(path.join(cwd, "acp"), mockFx);
      const runtime = yield* makeFxAcpRuntime({
        cwd,
        fxSettings: { binaryPath: process.execPath },
        clientInfo: { name: "cox-test", version: "0.0.0" },
        mcpServers: [{ name: "cox", command: "unused", args: [], env: [] }],
        ...(sessionId === undefined ? {} : { resumeSessionId: sessionId }),
      });
      assert.equal((yield* runtime.start()).sessionId, sessionId ?? "created");
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; T3
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });
});
