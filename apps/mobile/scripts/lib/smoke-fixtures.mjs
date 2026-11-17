import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { promisify } from "node:util";
import { WsRpcGroup, WS_METHODS } from "../../../../packages/contracts/src/rpc.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "../../../../packages/contracts/src/orchestrationV2.ts";

const requireServer = createRequire(new URL("../../../server/package.json", import.meta.url));
const Effect = requireServer("effect/Effect");
const Layer = requireServer("effect/Layer");
const RpcClient = requireServer("effect/rpc/RpcClient");
const RpcSerialization = requireServer("effect/rpc/RpcSerialization");
const Socket = requireServer("effect/socket/Socket");
const { WebSocket } = requireServer("undici");
const execFile = promisify(execFileCallback);

export async function createRepository(path) {
  await mkdir(path, { recursive: true });
  const git = (args) =>
    execFile("git", args, { cwd: path, env: { ...process.env, GIT_MASTER: "1" } });
  await git(["init", "-q"]);
  await git(["config", "user.name", "Cox Mobile Smoke"]);
  await git(["config", "user.email", "mobile-smoke@cox.invalid"]);
  await writeFile(join(path, "hello.ts"), "export const v = 1;\n");
  await git(["add", "hello.ts"]);
  await git(["commit", "-qm", "Initialize smoke repository"]);
  await writeFile(join(path, "hello.ts"), "export const v = 2;\n");
}

export async function withRpc(server, run) {
  const login = await fetch(`${server.origin}/api/auth/browser-session`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: server.origin },
    body: JSON.stringify({ credential: server.password }),
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const socket = Socket.layerWebSocket(
    `${server.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`,
  ).pipe(
    Layer.provide(
      Layer.succeed(
        Socket.WebSocketConstructor,
        (url) => new WebSocket(url, { headers: { cookie, origin: server.origin } }),
      ),
    ),
  );
  const protocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
  );
  return await Effect.runPromise(
    Effect.gen(function* () {
      const client = yield* RpcClient.make(WsRpcGroup);
      return yield* run(client);
    }).pipe(Effect.provide(protocol), Effect.scoped, Effect.timeout("30 seconds")),
  );
}

export async function seedThread(server) {
  await createRepository(server.repo);
  const projectId = crypto.randomUUID();
  const threadId = crypto.randomUUID();
  const result = await withRpc(server, (client) =>
    Effect.gen(function* () {
      yield* client[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: crypto.randomUUID(),
        projectId,
        title: server.label,
        workspaceRoot: server.repo,
      });
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand]({
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId,
        projectId,
        title: server.title,
        createdBy: "user",
        creationSource: "web",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      return yield* client[ORCHESTRATION_V2_WS_METHODS.getThreadProjection]({ threadId });
    }),
  );
  assert.equal(result.thread.title, server.title);
  assert.deepEqual(result.runs, []);
  return { ...server, projectId, threadId };
}

export async function readThreadFamily(server, threadId) {
  return await withRpc(server, (client) =>
    client[ORCHESTRATION_V2_WS_METHODS.getThreadFamily]({ threadId }),
  );
}
