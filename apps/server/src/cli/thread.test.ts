import { assert, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { CliError, Command } from "effect/cli";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  latestRunError,
  listProjectThreads,
  readLatestMessages,
  resolveProject,
  readOutputSchema,
  type ThreadTools,
  threadCommand,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

it.effect("--output-schema reads a ~/ path from the home directory", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "cox-thread-schema-" });
    yield* fs.writeFileString(path.join(home, "schema.json"), '{"type":"object"}');

    const output = yield* readOutputSchema(Option.some("~/schema.json")).pipe(
      Effect.provideService(HostProcess.HomeDirectory, home),
    );

    assert.deepStrictEqual(output, { outputSchema: { type: "object" } });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.each([
  ["CR", "\r"],
  ["Unicode line separator", "\u2028"],
  ["Unicode paragraph separator", "\u2029"],
])("uses only the first line of a message with %s line endings", (_name, newline) => {
  assert.strictEqual(titleFromMessage(`Review merge${newline}Check changelog`), "Review merge");
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("list includes delegated threads across pages and still leaves out subagents", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project-1");
    const root = { threadId: "root", relationshipToParent: null };
    const subagent = { threadId: "child", relationshipToParent: "subagent" };
    const delegated = {
      threadId: "delegated",
      relationshipToParent: null,
      delegatedFrom: { environmentId: "env-1", threadId: "remote", title: "Remote" },
    };
    const { tools, calls } = scriptedTools({
      cox_thread_list: [
        { threads: [root, subagent], nextCursor: 2 },
        { threads: [delegated], nextCursor: null },
      ],
    });
    const threads = yield* listProjectThreads(tools, projectId);
    assert.deepStrictEqual(
      threads.map((thread) => thread.threadId),
      ["root", "delegated"],
    );
    assert.deepStrictEqual(
      calls,
      [0, 2].map((cursor) => ({
        tool: "cox_thread_list",
        args: { projectId, cursor, includeSubagents: true, limit: 100 },
      })),
    );
  }),
);

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      cox_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      cox_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "cox_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait keeps typed output submitted after the requested turn completed", () =>
  Effect.gen(function* () {
    const { tools, calls } = scriptedTools({
      cox_thread_wait: [
        { threadId, runId, status: "completed", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false, output: { head: "abc" } },
      ],
      cox_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });
    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId, true), {
      type: "ended",
      runId,
      status: "completed",
      output: { head: "abc" },
    });
    assert.deepStrictEqual(
      calls.filter(({ tool }) => tool === "cox_thread_wait").map(({ args }) => args),
      [
        { threadId, runId, timeoutMs: 15_000, untilOutput: true },
        { threadId, runId, timeoutMs: 15_000, untilOutput: true },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      cox_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      cox_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      cox_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      cox_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

it.effect("selects the registered symlink alias and the deepest nested project", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-project-alias-" });
    const root = path.join(dir, "root");
    const alias = path.join(dir, "alias");
    const nested = path.join(root, "nested");
    yield* fs.makeDirectory(nested, { recursive: true });
    yield* fs.symlink(root, alias);
    const projects = [
      { id: ProjectId.make("root"), title: "Root", workspaceRoot: root },
      { id: ProjectId.make("alias"), title: "Alias", workspaceRoot: alias },
      { id: ProjectId.make("nested"), title: "Nested", workspaceRoot: nested },
    ];
    for (const [identifier, expected] of [
      [root, "root"],
      [alias, "alias"],
      [path.join(alias, "nested"), "nested"],
    ] as const) {
      const { tools } = scriptedTools({ cox_project_list: [{ projects, nextCursor: null }] });
      const project = yield* resolveProject(tools, identifier);
      assert.equal(project.id, ProjectId.make(expected));
    }
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.WorkingDirectory, process.cwd()),
  ),
);

it.effect("reports all equally deep projects for an unregistered worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-worktree-project-" });
    const root = path.join(dir, "repo");
    const alias = path.join(dir, "alias");
    const worktree = path.join(dir, "worktree");
    yield* fs.makeDirectory(path.join(root, "pkg"), { recursive: true });
    const git = (...args: string[]) =>
      spawner.string(ChildProcess.make("git", args, { cwd: root }));
    yield* git("init");
    yield* git(
      "-c",
      "user.name=Cox Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    yield* git("worktree", "add", "--detach", worktree);
    yield* fs.makeDirectory(path.join(worktree, "pkg"));
    yield* fs.symlink(root, alias);
    const projects = [
      { id: ProjectId.make("repo"), title: "Repository", workspaceRoot: root },
      { id: ProjectId.make("alias"), title: "Alias", workspaceRoot: alias },
      { id: ProjectId.make("pkg"), title: "Package", workspaceRoot: path.join(root, "pkg") },
    ];
    const from = (identifier: string) =>
      resolveProject(
        scriptedTools({ cox_project_list: [{ projects, nextCursor: null }] }).tools,
        identifier,
      );
    assert.equal((yield* from(path.join(worktree, "pkg"))).id, ProjectId.make("pkg"));
    const error = yield* Effect.flip(from(worktree));
    assert.include(error.message, "Repository (repo)");
    assert.include(error.message, "Alias (alias)");
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provideService(HostProcess.WorkingDirectory, process.cwd()),
    Effect.provideService(HostProcess.Platform, process.platform),
  ),
);

/** Serves cox_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    const isMessage = (item: (typeof items)[number]) =>
      ["user_message", "assistant_message", "proposed_plan"].includes(item.type);
    if (args.afterPosition === undefined) {
      const page = items.filter(isMessage).slice(-args.limit);
      served.push(page.length);
      return Effect.succeed({
        thread: { itemCount: items.length },
        items: page,
        nextPosition: null,
        hasMore: false,
      });
    }
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = args.afterPosition + 1; position < items.length; position++) {
      const item = items[position]!;
      if (isMessage(item)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show retains pull request metadata when reading a later message window", () =>
  Effect.gen(function* () {
    const link = {
      host: "github.com",
      repository: "owner/repo",
      number: 1,
      url: "https://github.com/owner/repo/pull/1",
      source: "manual",
      state: "open",
      watching: false,
      watchStartedAt: null,
    } as const;
    const call = ((_tool: string, input: unknown) => {
      const args = input as { afterPosition?: number; limit: number };
      const first = args.afterPosition === undefined && args.limit === 1;
      return Effect.succeed({
        thread: {
          itemCount: 200,
          status: first ? "running" : "completed",
          ...(first ? { pullRequests: [link] } : {}),
        },
        items: first ? [] : [{ position: 199, itemId: "message", type: "assistant_message" }],
        nextPosition: 199,
        hasMore: false,
      });
    }) as ThreadTools["call"];
    const { thread } = yield* readLatestMessages({ call }, threadId, 1);
    assert.strictEqual(thread.status, "completed");
    assert.deepStrictEqual(thread.pullRequests, [link]);
  }),
);

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it.effect("show rejects a negative --messages before reaching the server", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "cox-thread-show-messages-" });
    const show = (messages: string) =>
      Command.runWith(threadCommand, { version: "0.0.0" })([
        "show",
        threadId,
        "--messages",
        messages,
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);

    const error = yield* show("-1");
    if (!CliError.isCliError(error) || error._tag !== "ShowHelp") {
      assert.fail(`Expected ShowHelp, got ${String(error)}`);
    }
    const flagError = error.errors[0];
    if (flagError?._tag !== "InvalidValue") {
      assert.fail(`Expected InvalidValue, got ${String(flagError?._tag)}`);
    }
    assert.strictEqual(flagError.option, "messages");
    assert.strictEqual(flagError.value, "-1");
    // Zero is valid: it shows the thread's state with no messages.
    assert.strictEqual((yield* show("0"))._tag, "ThreadServerNotRunningError");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { COX_PORT: "3773" } })),
      ),
    ),
  ),
);

it.effect("show gives the latest run's last error only when that run did not complete", () =>
  Effect.gen(function* () {
    const page = {
      thread: {},
      items: [
        { itemId: "item-0", runId: RunId.make("run-0"), type: "error", text: "earlier run" },
        { itemId: "item-1", runId, type: "error", text: "first try" },
        { itemId: "item-2", runId, type: "error", text: "Usage limit reached" },
      ],
      nextPosition: null,
      hasMore: false,
    };
    const { tools, calls } = scriptedTools({ cox_thread_read: [page] });

    assert.strictEqual(
      yield* latestRunError(tools, { threadId, status: "failed", latestRunId: runId }),
      "Usage limit reached",
    );
    assert.deepInclude(calls[0]?.args, { view: "activity" });
    for (const status of ["completed", "running", "queued", "idle"] as const) {
      assert.isNull(yield* latestRunError(tools, { threadId, status, latestRunId: runId }), status);
    }
    assert.lengthOf(calls, 1);
  }),
);
