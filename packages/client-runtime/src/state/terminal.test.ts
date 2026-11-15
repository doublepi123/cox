import {
  EnvironmentId,
  ThreadId,
  type TerminalCloseInput,
  type TerminalOpenInput,
  type TerminalResizeInput,
  type TerminalWriteInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vite-plus/test";

import {
  createTerminalSession,
  INITIAL_TERMINAL_LIFECYCLE,
  transitionTerminalLifecycle,
  type TerminalLifecycleEvent,
  type TerminalSessionMode,
} from "./terminal.ts";
import { runAtomCommand } from "./runtime.ts";
import { EMPTY_TERMINAL_BUFFER_STATE, type TerminalBufferState } from "./terminalSession.ts";

function run(events: ReadonlyArray<TerminalLifecycleEvent>) {
  let state = INITIAL_TERMINAL_LIFECYCLE;
  const commands: Array<string> = [];
  for (const event of events) {
    const step = transitionTerminalLifecycle(state, event);
    state = step.state;
    if (step.command !== null) commands.push(step.command);
  }
  return commands;
}

const status = (value: TerminalBufferState["status"], version = 1): TerminalLifecycleEvent => ({
  type: "status",
  status: value,
  version,
});

it("does not respawn a terminal that exited after operate was revoked", () => {
  expect(
    run([status("running"), { type: "detached", canOperate: false }, status("exited")]),
  ).toEqual([]);
});

it("reopens an ended terminal on an explicit visit, once until it runs again", () => {
  expect(run([status("exited"), status("exited", 2)])).toEqual(["reopen"]);
  expect(run([status("exited"), status("running", 3), status("exited", 4)])).toEqual([
    "reopen",
    "exit",
  ]);
  expect(run([status("exited"), { type: "reopen-failed" }, status("exited", 2)])).toEqual([
    "reopen",
    "reopen",
  ]);
});

it("keeps a detached terminal from being mistaken for a live exit", () => {
  expect(
    run([status("running"), { type: "detached", canOperate: true }, status("exited")]),
  ).toEqual(["reopen"]);
});

it("leaves the history a viewer was reading when operate is granted", () => {
  expect(run([{ type: "observed" }, status("exited")])).toEqual([]);
});

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

type CommandInput =
  | TerminalOpenInput
  | TerminalResizeInput
  | TerminalWriteInput
  | TerminalCloseInput;

function setup(
  options: {
    readonly initialInput?: string;
    readonly beforeCommand?: (name: string, input: CommandInput) => Promise<void>;
    readonly resizeFailure?: () => boolean;
    readonly resizeInterrupted?: () => boolean;
  } = {},
) {
  // Tests flush the registry's scheduled work to control when driver finalizers run.
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (const task of scheduled.splice(0)) task();
  };
  const attachment = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const observation = Atom.make<AsyncResult.AsyncResult<TerminalBufferState, unknown>>(
    AsyncResult.initial(true),
  );
  const access = { canOperate: true };
  const calls: Array<{ readonly command: string; readonly input: CommandInput }> = [];
  const pending: Promise<unknown>[] = [];
  const command = (name: string) => ({
    label: name,
    run: (_registry: AtomRegistry.AtomRegistry, value: { readonly input: CommandInput }) => {
      const result = (async () => {
        calls.push({ command: name, input: value.input });
        if (options.beforeCommand) await options.beforeCommand(name, value.input);
        if (name === "resize" && options.resizeInterrupted?.())
          return AsyncResult.failure(Cause.interrupt());
        return name === "resize" && options.resizeFailure?.()
          ? AsyncResult.failure(Cause.fail("resize rejected"))
          : AsyncResult.success(undefined);
      })();
      pending.push(result);
      return result;
    },
  });
  const write = command("write");
  // Await command completion, then a normal input receipt through the same command runner.
  const completeCommands = async (count = pending.length) => {
    await Promise.all(pending.slice(0, count));
    await runAtomCommand(registry, write, {
      input: { threadId, terminalId: "term-1", data: "typed" },
    });
  };
  const exits: Array<true> = [];
  const live: Array<boolean> = [];
  const session = createTerminalSession(
    {
      attach: () => attachment,
      observe: () => observation,
      open: command("open"),
      resize: command("resize"),
      write,
      close: command("close"),
    },
    {
      target: { environmentId, threadId, terminalId: "term-1" },
      gridSize: { cols: 120, rows: 40 },
      initialInput: options.initialInput,
      canOperate: () => access.canOperate,
      onExit: () => exits.push(true),
      onLiveChange: (value) => live.push(value),
    },
  );
  const attached: TerminalSessionMode = {
    kind: "attached",
    input: { threadId, terminalId: "term-1", cwd: "/repo", cols: 80, rows: 24 },
  };
  const snapshot = (state: Partial<TerminalBufferState> & { readonly generation?: number }) => {
    const { generation = 1, ...rest } = state;
    return AsyncResult.success({
      ...EMPTY_TERMINAL_BUFFER_STATE,
      output: { ...EMPTY_TERMINAL_BUFFER_STATE.output, generation },
      ...rest,
    });
  };
  const emit = (state: Partial<TerminalBufferState> & { readonly generation?: number }) =>
    registry.set(attachment, snapshot(state));
  // A new attach subscription starts from an empty seed.
  const detach = () => registry.set(attachment, AsyncResult.initial(true));
  const observe = (state: Partial<TerminalBufferState>) =>
    registry.set(observation, snapshot(state));
  const mount = (mode: TerminalSessionMode) => registry.mount(session.driver(mode));
  const of = (name: string) => calls.filter((call) => call.command === name).map((c) => c.input);
  return {
    session,
    attached,
    access,
    flush,
    detach,
    emit,
    observe,
    mount,
    calls,
    of,
    exits,
    live,
    completeCommands,
  };
}

it("replays the measured grid on every new attachment generation", () => {
  const { session, attached, emit, mount, of } = setup();
  mount(attached);
  emit({ status: "running", version: 1 });
  expect(of("resize")).toEqual([{ threadId, terminalId: "term-1", cols: 120, rows: 40 }]);

  session.reportGridSize({ cols: 100, rows: 30 });
  expect(of("resize")).toHaveLength(2);
  session.reportGridSize({ cols: 100, rows: 30 });
  expect(of("resize")).toHaveLength(2);

  // A reconnect seeds an empty state first, then the new generation's snapshot.
  emit({ status: "running", version: 0, generation: 2 });
  expect(of("resize")).toHaveLength(2);
  emit({ status: "running", version: 1, generation: 2 });
  expect(of("resize")).toHaveLength(3);
  emit({ status: "running", version: 2, generation: 3 });
  expect(of("resize")).toEqual([
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
  ]);
});

it("sends each failed resize again once, in every attachment generation", async () => {
  // Resizes stay in flight until the test settles them, and every one fails.
  const resizes: Array<() => void> = [];
  const { session, attached, emit, detach, mount, of } = setup({
    resizeFailure: () => true,
    beforeCommand: (name) =>
      name === "resize" ? new Promise<void>((resolve) => resizes.push(resolve)) : Promise.resolve(),
  });
  const failResize = async (index: number) => {
    resizes[index]!();
    // No promise marks the retry decision, so flush the command's continuation chain.
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  };
  mount(attached);
  emit({ status: "running", version: 1 });
  detach();
  await failResize(0);
  expect(of("resize")).toHaveLength(1);

  emit({ status: "running", version: 1, generation: 2 });
  await failResize(1);
  expect(of("resize")).toHaveLength(3);
  await failResize(2);
  session.reportGridSize({ cols: 100, rows: 30 });
  await failResize(3);
  await failResize(4);
  expect(of("resize")).toEqual([
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
  ]);
});

it("does not retry a failed resize that a newer one replaced", async () => {
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  let resizes = 0;
  let settling = -1;
  const { session, attached, emit, mount, of, completeCommands } = setup({
    initialInput: "pnpm dev\r",
    // The newer resize succeeds; the superseded one, and any retry of it, fail.
    resizeFailure: () => settling !== 1,
    beforeCommand: (name) => {
      if (name !== "resize") return Promise.resolve();
      const call = resizes++;
      return gates[call]!.promise.then(() => {
        settling = call;
      });
    },
  });
  session.reportGridSize({ cols: 120, rows: 40 });
  mount(attached);
  emit({ status: "running", version: 1 });
  expect(of("write")).toEqual([{ threadId, terminalId: "term-1", data: "pnpm dev\r" }]);
  session.reportGridSize({ cols: 100, rows: 30 });
  gates[0]!.resolve();
  await completeCommands(1);
  gates[1]!.resolve();
  await completeCommands();
  expect(of("resize")).toEqual([
    { threadId, terminalId: "term-1", cols: 120, rows: 40 },
    { threadId, terminalId: "term-1", cols: 100, rows: 30 },
  ]);
});

it("does not resend an interrupted resize", async () => {
  const resizes: Array<() => void> = [];
  const { attached, emit, mount, of } = setup({
    resizeInterrupted: () => true,
    beforeCommand: (name) =>
      name === "resize" ? new Promise<void>((resolve) => resizes.push(resolve)) : Promise.resolve(),
  });
  const settleResize = async (index: number) => {
    resizes[index]!();
    // No promise marks the retry decision, so flush the command's continuation chain.
    for (let tick = 0; tick < 20; tick++) await Promise.resolve();
  };
  mount(attached);
  emit({ status: "running", version: 1 });
  await settleResize(0);
  expect(of("resize")).toEqual([{ threadId, terminalId: "term-1", cols: 120, rows: 40 }]);
});

it("writes the launch's initial input once the first snapshot lands", () => {
  const { attached, emit, mount, calls, of } = setup({ initialInput: "pnpm dev\r" });
  mount(attached);
  expect(of("write")).toEqual([]);
  emit({ status: "running", version: 1 });
  emit({ status: "running", version: 2 });
  expect(of("write")).toEqual([{ threadId, terminalId: "term-1", data: "pnpm dev\r" }]);
  // The shell gets the measured grid before the launched command runs.
  expect(calls.map((call) => call.command)).toEqual(["resize", "write"]);
});

it("closes and reports a shell that exits while attached", () => {
  const { attached, emit, mount, of, exits, live } = setup();
  mount(attached);
  emit({ status: "running", version: 1, lifecycleVersion: 0 });
  emit({ status: "exited", version: 2 });
  expect(of("close")).toEqual([{ threadId, terminalId: "term-1" }]);
  expect(of("open")).toEqual([]);
  expect(exits).toHaveLength(1);
  expect(live).toEqual([true, false]);
});

it("does not reopen an ended shell after a viewer is granted operate", () => {
  const { attached, flush, access, emit, observe, mount, of } = setup();
  access.canOperate = false;
  const unmountViewer = mount({ kind: "observing" });
  observe({ status: "exited", version: 1 });
  access.canOperate = true;
  unmountViewer();
  flush();
  mount(attached);
  emit({ status: "exited", version: 1 });
  expect(of("open")).toEqual([]);
});

it("does not reopen on grant when the viewer had no snapshot yet", () => {
  const { attached, flush, access, emit, mount, of } = setup();
  access.canOperate = false;
  const unmountViewer = mount({ kind: "observing" });
  access.canOperate = true;
  unmountViewer();
  flush();
  mount(attached);
  emit({ status: "exited", version: 1 });
  expect(of("open")).toEqual([]);
});

it("leaves a shell that exited after operate was revoked mid-run", () => {
  const { attached, flush, access, detach, emit, mount, of, exits } = setup();
  const unmountAttached = mount(attached);
  emit({ status: "running", version: 1 });
  access.canOperate = false;
  unmountAttached();
  flush();
  detach();
  access.canOperate = true;
  mount(attached);
  emit({ status: "exited", version: 2 });
  expect(of("open")).toEqual([]);
  expect(of("close")).toEqual([]);
  expect(exits).toEqual([]);
});

it("reopens instead of closing a shell that ended while detached", () => {
  const { attached, flush, detach, emit, mount, of, exits } = setup();
  const unmountAttached = mount(attached);
  emit({ status: "running", version: 1 });
  unmountAttached();
  flush();
  detach();
  mount(attached);
  emit({ status: "exited", version: 2 });
  expect(of("close")).toEqual([]);
  expect(exits).toEqual([]);
  expect(of("open")).toHaveLength(1);
});

it("keeps one attached driver, so a remount before release keeps its state", () => {
  const { session, attached, flush, emit, mount, of, exits } = setup();
  const driver = session.driver(attached);
  expect(session.driver({ ...attached })).toBe(driver);
  const unmountFirst = mount(attached);
  emit({ status: "running", version: 1 });
  // A brief disconnect unmounts and remounts the driver before its release runs.
  unmountFirst();
  mount(attached);
  flush();
  emit({ status: "exited", version: 2 });
  expect(of("close")).toHaveLength(1);
  expect(exits).toHaveLength(1);
});
