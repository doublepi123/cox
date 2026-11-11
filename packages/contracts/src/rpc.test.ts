import { describe, expect, it } from "vite-plus/test";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";
import { clientRpcRequiredScopes } from "./clientRpcPermissions.ts";
import { AuthProvidersManageScope } from "./auth.ts";
import { ModelServiceRecommendOmoModelsResult } from "./modelService.ts";

describe("WebSocket RPC contracts", () => {
  it("registers OMO recommendations with validated role names and a binding", () => {
    const rpc = WsRpcGroup.requests.get(WS_METHODS.modelServiceRecommendOmoModels);
    if (!rpc) throw new Error("modelService.recommendOmoModels is not registered");
    expect(clientRpcRequiredScopes(WS_METHODS.modelServiceRecommendOmoModels, undefined)).toEqual([
      AuthProvidersManageScope,
    ]);
    const decode = Schema.decodeUnknownExit(rpc.payloadSchema);
    const input = {
      serviceId: "models",
      revision: 1,
      modelId: "generator",
      binding: { serviceId: "models", modelIds: ["generator"] },
      agents: ["sisyphus", "custom-agent"],
      categories: ["quick"],
    };
    expect(Exit.isSuccess(decode(input))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, agents: ["invalid.role"] }))).toBe(true);
    for (const name of ["1agent", "__proto__", "constructor", "prototype", " sisyphus "]) {
      expect(Exit.isFailure(decode({ ...input, agents: [name] }))).toBe(true);
      expect(Exit.isFailure(decode({ ...input, categories: [name] }))).toBe(true);
    }
    expect(Exit.isFailure(decode({ ...input, categories: ["a".repeat(65)] }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, binding: undefined }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, revision: -1 }))).toBe(true);
    const decodeResult = Schema.decodeUnknownExit(ModelServiceRecommendOmoModelsResult);
    for (const name of ["1agent", "constructor", "prototype", "invalid.role"]) {
      expect(
        Exit.isFailure(
          decodeResult({
            agentModels: { [name]: "cox/generator" },
            categoryModels: {},
            explanation: "Explanation.",
          }),
        ),
      ).toBe(true);
    }
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });

  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});
