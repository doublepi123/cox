import * as NodeOS from "node:os";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";

it.layer(NodeServices.layer)("ClaudeHome", (it) => {
  describe("Claude home resolution", () => {
    it.effect("uses per-instance gateway credentials without modifying inherited credentials", () =>
      Effect.gen(function* () {
        const base = {
          ANTHROPIC_API_KEY: "old",
          ANTHROPIC_AUTH_TOKEN: "old-token",
          CLAUDE_CODE_OAUTH_TOKEN: "subscription",
        };
        const environment = yield* makeClaudeEnvironment(
          { homePath: "", baseUrl: "https://gateway.test/v1/", apiKey: "new-api-key" },
          base,
        );
        expect(environment.ANTHROPIC_BASE_URL).toBe("https://gateway.test");
        expect(environment.ANTHROPIC_API_KEY).toBe("new-api-key");
        expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
        expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
        expect(base.CLAUDE_CODE_OAUTH_TOKEN).toBe("subscription");
      }),
    );
    it.effect("resolves configured Claude HOME and stamps continuation/cache keys with it", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homePath = "~/.claude-work";
        const resolved = path.resolve(NodeOS.homedir(), ".claude-work");

        expect(yield* resolveClaudeHomePath({ homePath })).toBe(resolved);
        expect((yield* makeClaudeEnvironment({ homePath })).CLAUDE_CONFIG_DIR).toBe(resolved);
        expect(yield* makeClaudeContinuationGroupKey({ homePath })).toBe(`claude:home:${resolved}`);
        expect(yield* makeClaudeCapabilitiesCacheKey({ binaryPath: "claude", homePath })).toBe(
          `claude\0${resolved}\0`,
        );
      }),
    );

    it.effect("uses inherited CLAUDE_CONFIG_DIR when homePath is empty", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const inherited = path.resolve("/tmp/claude-inherited");
        const environment = { CLAUDE_CONFIG_DIR: inherited };

        expect(yield* resolveClaudeHomePath({ homePath: "" }, environment)).toBe(inherited);
        expect(yield* makeClaudeContinuationGroupKey({ homePath: "" }, environment)).toBe(
          `claude:home:${inherited}`,
        );

        const explicit = path.resolve(NodeOS.homedir(), ".claude-work");
        expect(yield* resolveClaudeHomePath({ homePath: "~/.claude-work" }, environment)).toBe(
          explicit,
        );
      }),
    );

    it.effect("separates capability probes by cwd", () =>
      Effect.gen(function* () {
        const config = { binaryPath: "claude", homePath: "" };
        const first = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-a");
        const second = yield* makeClaudeCapabilitiesCacheKey(config, "/repo-b");
        expect(first).not.toBe(second);
      }),
    );

    it.effect("strips inherited Claude host session variables from spawned environment", () =>
      Effect.gen(function* () {
        const host = {
          CLAUDECODE: "1",
          CLAUDE_CODE_SESSION_ID: "host-session",
          CLAUDE_CODE_HOST_SESSION_ID: "host-session",
          CLAUDE_CODE_CHILD_SESSION: "1",
          CLAUDE_CODE_SESSION_ATTENDED: "1",
          CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/claude.sock",
          CLAUDE_CODE_MESSAGING_TOKEN: "secret",
          CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
          CLAUDE_CODE_DESKTOP_APP_VERSION: "1.0.0",
          CLAUDE_EFFORT: "max",
          CLAUDE_PID: "1234",
          CLAUDE_AGENT_SDK_VERSION: "0.2.0",
          KEEP: "1",
        };
        const env = yield* makeClaudeEnvironment({ homePath: "" }, host);
        expect(env).toEqual({ KEEP: "1" });
      }),
    );
  });
});
