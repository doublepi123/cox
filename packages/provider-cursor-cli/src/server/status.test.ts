import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CursorCliSettings } from "../settings.ts";
import {
  checkCursorCliProviderStatus,
  cursorCliModelsFromAvailableModels,
  parseCursorCliAbout,
} from "./status.ts";

const mockAgent = `#!/usr/bin/env node
const args = process.argv.slice(2);
const signedIn = process.env.MOCK_CURSOR_SIGNED_IN === "1";
if (args.includes("about")) {
  console.log(JSON.stringify({
    cliVersion: "2026.11.19-f005e9d",
    latestVersion: "2026.11.22-e9042b2",
    subscriptionTier: signedIn ? "Pro" : null,
    userEmail: signedIn ? "dev@example.com" : null,
  }, null, 2));
  process.exit(0);
}
if (args[args.length - 1] !== "acp") process.exit(2);
let picker = false;
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const reply = (body) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  if (method === "initialize") {
    picker = params.clientCapabilities?._meta?.parameterizedModelPicker === true;
    return reply({ result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: "cursor_login", name: "Cursor Login" }] } });
  }
  if (method === "cursor/list_available_models") {
    if (!signedIn) return reply({ error: { code: -32000, message: "Authentication required" } });
    if (!picker) return reply({ error: { code: -32602, message: "parameterized picker not requested" } });
    return reply({ result: { models: [
      { value: "default", name: "Auto", configOptions: [] },
      { value: "grok-4.7", name: "Grok 4.7", configOptions: [
        { id: "reasoning_effort", name: "Effort", category: "thought_level", type: "select", currentValue: "high",
          options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
        { id: "fast", name: "Fast", category: "model_config", type: "boolean", currentValue: true },
      ] },
    ] } });
  }
  reply({ error: { code: -32601, message: "Method not found: " + method } });
});
`;

const decodeSettings = Schema.decodeEffect(CursorCliSettings);

const check = (signedIn: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cox-cursor-cli-" });
    const binaryPath = path.join(directory, "cursor-agent");
    yield* fileSystem.writeFileString(binaryPath, mockAgent);
    yield* fileSystem.chmod(binaryPath, 0o755);
    const settings = yield* decodeSettings({ enabled: true, binaryPath });
    return yield* checkCursorCliProviderStatus(
      settings,
      { ...process.env, MOCK_CURSOR_SIGNED_IN: signedIn ? "1" : "0" },
      directory,
    );
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

describe("checkCursorCliProviderStatus", () => {
  it.effect("reports a signed-in CLI as ready with its discovered models", () =>
    Effect.gen(function* () {
      const draft = yield* check(true);
      assert.equal(draft.status, "ready");
      assert.equal(draft.version, "2026.11.19-f005e9d");
      assert.deepStrictEqual(
        { status: draft.auth.status, email: draft.auth.email },
        { status: "authenticated", email: "dev@example.com" },
      );
      assert.deepStrictEqual(
        draft.models.map((model) => model.slug),
        ["default", "grok-4.7"],
      );
    }),
  );

  it.effect("reports a signed-out CLI as unauthenticated with sign-in guidance", () =>
    Effect.gen(function* () {
      const draft = yield* check(false);
      assert.equal(draft.status, "error");
      assert.equal(draft.installed, true);
      assert.equal(draft.auth.status, "unauthenticated");
      assert.include(draft.message ?? "", "cursor-agent login");
    }),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      const settings = yield* decodeSettings({
        enabled: true,
        binaryPath: "/nonexistent/cursor-agent",
      });
      const draft = yield* checkCursorCliProviderStatus(settings, process.env, "/");
      assert.equal(draft.installed, false);
      assert.equal(draft.status, "error");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("Cursor CLI status parsing", () => {
  it("reads version and account from `about --format json`", () => {
    assert.deepStrictEqual(
      parseCursorCliAbout(
        '{\n  "cliVersion": "2026.11.19-f005e9d",\n  "subscriptionTier": "Super",\n  "userEmail": "dev@example.com"\n}\n',
      ),
      {
        version: "2026.11.19-f005e9d",
        email: "dev@example.com",
        subscriptionTier: "Super",
      },
    );
  });

  it("maps per-model ACP options to reasoning and boolean descriptors", () => {
    const [, grok] = cursorCliModelsFromAvailableModels({
      models: [
        { value: "default", name: "Auto", configOptions: [] },
        {
          value: "grok-4.7",
          name: "Grok 4.7",
          configOptions: [
            {
              id: "reasoning_effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
            {
              id: "fast",
              name: "Fast",
              category: "model_config",
              type: "boolean",
              currentValue: true,
            },
            { id: "future", name: "Future", type: "slider", currentValue: 3 },
          ],
        },
      ],
    });
    assert.deepStrictEqual(
      grok?.capabilities?.optionDescriptors?.map((descriptor) => ({
        id: descriptor.id,
        type: descriptor.type,
        role: "role" in descriptor ? descriptor.role : undefined,
      })),
      [
        { id: "reasoning_effort", type: "select", role: "reasoning" },
        { id: "fast", type: "boolean", role: undefined },
      ],
    );
  });
});
