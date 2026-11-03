import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  attachedTerminalIds: new Set<string>(),
  pressedKeys: [] as unknown[],
  compact: false,
  coarsePointer: false,
}));

// Every surface method is a no-op; `then` stays undefined so awaiting the surface resolves to it.
const fakeSurface: object = new Proxy(
  {
    input: document.createElement("textarea"),
    pressKey: (press: unknown) => fixture.pressedKeys.push(press),
  },
  {
    get: (target, key) =>
      key === "then" ? undefined : key in target ? Reflect.get(target, key) : () => undefined,
  },
);
vi.mock("~/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: {
    create: () =>
      new Promise((resolve) => {
        fixture.pendingSurfaces.push(() => resolve(fakeSurface));
      }),
  },
}));
vi.mock("../hooks/useMediaQuery", () => ({
  useMediaQuery: (query: unknown) =>
    query === "max-sm" ? fixture.compact : typeof query === "object" && fixture.coarsePointer,
}));
vi.mock("../state/terminalSessions", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const sessions = Atom.family((_environmentId: EnvironmentId) =>
    Atom.family((threadId: ThreadId) =>
      Atom.make({
        ...EMPTY_TERMINAL_SESSION_STATE,
        status: fixture.statusByThreadId.get(threadId) ?? "closed",
        version: 1,
      }),
    ),
  );
  return {
    attachedTerminalSessionAtom: (
      environmentId: EnvironmentId,
      terminal: { threadId: ThreadId; terminalId: string },
    ) => {
      fixture.attachedTerminalIds.add(terminal.terminalId);
      return sessions(environmentId)(terminal.threadId);
    },
  };
});
vi.mock("../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));
// The commands are replaced above; importing their runtime would connect a client.
vi.mock("../state/server", async () => {
  const Atom = await import("effect/reactivity/Atom");
  const config = Atom.make(null);
  return { serverEnvironment: { configValueAtom: () => config } };
});
vi.mock("../state/terminal", () => ({ terminalEnvironment: { write: {}, resize: {} } }));
vi.mock("../state/preview", () => ({ previewEnvironment: { open: {} } }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("./preview/openTerminalLinkInPreview", () => ({ openTerminalLinkInPreview: () => {} }));
vi.mock("~/localApi", () => ({ readLocalApi: () => null }));
vi.mock("../hooks/useSettings", async () => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts/settings");
  return {
    useClientSettings: <T,>(select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => T) =>
      select(DEFAULT_CLIENT_SETTINGS),
  };
});

function Drawer(props: {
  threadRef: ScopedThreadRef;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd="/repo"
      height={240}
      terminalIds={["term-1"]}
      activeTerminalId="term-1"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={() => {}}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={[]}
    />
  );
}

function setup() {
  const original: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-a"),
    threadId: ThreadId.make("thread-a"),
  };
  const other: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-b"),
    threadId: ThreadId.make("thread-b"),
  };
  fixture.statusByThreadId = new Map([
    [original.threadId, "exited"],
    [other.threadId, "running"],
  ]);
  fixture.pendingSurfaces = [];
  fixture.attachedTerminalIds = new Set();
  fixture.pressedKeys = [];
  fixture.compact = false;
  fixture.coarsePointer = false;
  return { original, other };
}

function SplitDrawer(props: {
  threadRef: ScopedThreadRef;
  onActiveTerminalChange: (terminalId: string) => void;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd="/repo"
      height={240}
      terminalIds={["term-1", "term-2"]}
      activeTerminalId="term-2"
      terminalGroups={[{ id: "group-1", terminalIds: ["term-1", "term-2"] }]}
      activeTerminalGroupId="group-1"
      onSplitTerminal={() => {}}
      onSplitTerminalVertical={() => {}}
      onNewTerminal={() => {}}
      onActiveTerminalChange={props.onActiveTerminalChange}
      onCloseTerminal={props.onCloseTerminal}
      onHeightChange={() => {}}
      onAddTerminalContext={() => {}}
      keybindings={[]}
    />
  );
}

it("closes an exited terminal on its own thread after navigating to one reusing its ID", async () => {
  const { original, other } = setup();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <Drawer threadRef={original} onCloseTerminal={onCloseTerminal} />,
  );
  using _timers = fakeTimers();
  // The exit is seen once the surface loads, and its close waits for the next task.
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  await screen.rerender(<Drawer threadRef={other} onCloseTerminal={onCloseTerminal} />);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(onCloseTerminal.mock.calls).toEqual([["term-1", original]]);
});

it("shows one terminal with tabs on phones and sends touch keys to it without taking focus", async () => {
  const { other } = setup();
  fixture.compact = true;
  fixture.coarsePointer = true;
  const onActiveTerminalChange = vi.fn();
  const onCloseTerminal = vi.fn();
  await using screen = await render(
    <SplitDrawer
      threadRef={other}
      onActiveTerminalChange={onActiveTerminalChange}
      onCloseTerminal={onCloseTerminal}
    />,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  expect(fixture.pendingSurfaces).toHaveLength(0);
  expect([...fixture.attachedTerminalIds]).toEqual(["term-2"]);
  expect(screen.container.querySelector('[aria-label^="Split Terminal"]')).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: "Terminal 2" }))
    .toHaveAttribute("aria-current", "true");

  const interrupt = screen.getByRole("button", { name: "Send Ctrl+C" });
  const pointerDown = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  interrupt.element().dispatchEvent(pointerDown);
  expect(pointerDown.defaultPrevented).toBe(true);
  await interrupt.click();
  expect(fixture.pressedKeys).toEqual([{ key: "c", code: "KeyC", ctrlKey: true }]);

  await screen.getByRole("button", { name: "Terminal 1" }).click();
  expect(onActiveTerminalChange).toHaveBeenCalledWith("term-1");
  await screen.getByRole("button", { name: "Close terminal" }).click();
  await vi.waitFor(() => expect(onCloseTerminal).toHaveBeenCalledWith("term-2", other));
});

it("keeps split panes, the floating actions and no touch keys on desktop", async () => {
  const { other } = setup();
  await using screen = await render(
    <SplitDrawer threadRef={other} onActiveTerminalChange={() => {}} onCloseTerminal={() => {}} />,
  );
  expect(fixture.pendingSurfaces).toHaveLength(2);
  expect([...fixture.attachedTerminalIds].toSorted()).toEqual(["term-1", "term-2"]);
  expect(screen.container.querySelectorAll('[aria-label^="Split Terminal"]')).toHaveLength(2);
  expect(screen.container.querySelector("[data-terminal-touch-keys]")).toBeNull();
});
