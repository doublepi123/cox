import { EMPTY_TERMINAL_SESSION_STATE } from "@t3tools/client-runtime/state/terminal";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ThreadId,
  type ScopedThreadRef,
  type FilesystemEntryMetadata,
} from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import type { GhosttyTerminalSurfaceOptions } from "~/terminal/ghostty/surface";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import { extractTerminalLinks } from "../terminal-links";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../test/render";
import ThreadTerminalDrawer from "./ThreadTerminalDrawer";

const fixture = vi.hoisted(() => ({
  statusByThreadId: new Map<string, "running" | "exited">(),
  pendingSurfaces: [] as Array<() => void>,
  surfaceOptions: [] as GhosttyTerminalSurfaceOptions[],
  deniedScopes: new Set<string>(),
  metadataRequests: [] as string[],
  metadata: new Map<
    string,
    Atom.Writable<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>
  >(),
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
    create: (_mount: HTMLElement, options: GhosttyTerminalSurfaceOptions) =>
      new Promise((resolve) => {
        fixture.surfaceOptions.push(options);
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
  useEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    !fixture.deniedScopes.has(scope),
  readEnvironmentScope: (_environmentId: EnvironmentId, scope: string) =>
    !fixture.deniedScopes.has(scope),
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
vi.mock("../state/projects", async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  return {
    projectEnvironment: {
      fileMetadata: ({
        environmentId,
        input,
      }: {
        environmentId: string;
        input: { path: string };
      }) => {
        const key = JSON.stringify([environmentId, input.path]);
        fixture.metadataRequests.push(key);
        let atom = fixture.metadata.get(key);
        if (!atom) {
          atom = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
            AsyncResult.success(null),
          );
          fixture.metadata.set(key, atom);
        }
        return atom;
      },
    },
  };
});
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
  cwd?: string;
  onCloseTerminal: (terminalId: string, threadRef?: ScopedThreadRef) => void;
}) {
  return (
    <ThreadTerminalDrawer
      threadRef={props.threadRef}
      threadId={props.threadRef.threadId}
      cwd={props.cwd ?? "/repo"}
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
  fixture.surfaceOptions = [];
  fixture.deniedScopes.clear();
  fixture.metadataRequests = [];
  fixture.metadata.clear();
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

it("only activates terminal paths confirmed to exist on their environment", async () => {
  const { other: threadRef } = setup();
  const key = (path: string) => JSON.stringify([threadRef.environmentId, path]);
  const pending = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
    AsyncResult.initial(),
  );
  fixture.metadata.set(key("/repo/src/main.ts"), pending);
  fixture.metadata.set(
    key("/repo/src/…notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  fixture.metadata.set(
    key("/repo/src"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "directory" }),
    ),
  );
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  const canActivate = (text: string) => fixture.surfaceOptions.at(-1)!.canActivateLink!(text);
  const validate = (text: string) => fixture.surfaceOptions.at(-1)!.validateLink!(text);
  const hover = (text: string | null) =>
    act(() => fixture.surfaceOptions.at(-1)!.onLinkHover!(text));

  expect(canActivate("https://example.com")).toBe(true);
  for (const branch of ["t3/fix-html-image-details", "t3/fix-html-…mage-details"]) {
    const candidates = extractTerminalLinks(branch);
    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(canActivate(candidate.text)).toBe(false);
      await hover(candidate.text);
      expect(canActivate(candidate.text)).toBe(false);
      expect(await validate(candidate.text)).toBe(false);
    }
  }
  const pressedValidation = validate("src/main.ts:12:7");
  await hover("src/main.ts:12:7");
  expect(canActivate("src/main.ts:12:7")).toBe(false);
  await act(async () => {
    appAtomRegistry.set(pending, AsyncResult.success({ kind: "file" }));
  });
  expect(canActivate("src/main.ts:12:7")).toBe(true);
  expect(await pressedValidation).toBe(true);
  expect(canActivate("missing/file.ts")).toBe(false);
  await hover("missing/file.ts");
  expect(canActivate("missing/file.ts")).toBe(false);
  for (const path of ["/repo/src/…notes.ts", "/repo/src"]) {
    await hover(path);
    expect(canActivate(path)).toBe(true);
  }
  await hover(null);
  expect(canActivate("/repo/src")).toBe(false);
  fixture.metadata.set(
    key("/home/alice/notes.ts"),
    Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
      AsyncResult.success<FilesystemEntryMetadata | null>({ kind: "file" }),
    ),
  );
  await screen.rerender(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} cwd="/home/alice/project" onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  await act(async () => {
    fixture.pendingSurfaces.shift()?.();
  });
  expect(await validate("~/notes.ts:5:2")).toBe(true);
  await hover("~/notes.ts:5:2");
  expect(canActivate("~/notes.ts:5:2")).toBe(true);
});

it("rejects terminal metadata probes for network paths, long paths and missing grants", async () => {
  const { other: threadRef } = setup();
  await using screen = await render(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  const options = fixture.surfaceOptions.at(-1)!;
  const networkPaths = [
    String.raw`\\host\share\file.ts`,
    "//host/share/file.ts",
    String.raw`/\host\share\file.ts`,
    String.raw`\/host/share/file.ts`,
    String.raw`\\?\UNC\host\share\file.ts`,
  ];
  for (const path of [...networkPaths, `/repo/${"a".repeat(513)}.ts`]) {
    expect(await options.validateLink!(path)).toBe(false);
    await act(() => options.onLinkHover!(path));
    expect(options.canActivateLink!(path)).toBe(false);
  }
  for (const scope of [AuthFilesystemReadScope, AuthOrchestrationOperateScope]) {
    fixture.deniedScopes.add(scope);
    expect(await options.validateLink!("src/denied.ts")).toBe(false);
    expect(options.canActivateLink!("src/denied.ts")).toBe(false);
    expect(await options.validateLink!("https://example.com")).toBe(true);
    await screen.rerender(
      <AppAtomRegistryProvider>
        <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
      </AppAtomRegistryProvider>,
    );
    await act(() => options.onLinkHover!("src/denied.ts"));
    fixture.deniedScopes.delete(scope);
  }
  expect(fixture.metadataRequests).toEqual([]);
});

it("rechecks terminal filesystem grants after pending metadata completes", async () => {
  const { other: threadRef } = setup();
  const pending = Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null>>(
    AsyncResult.initial(),
  );
  fixture.metadata.set(JSON.stringify([threadRef.environmentId, "/repo/src/pending.ts"]), pending);
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <Drawer threadRef={threadRef} onCloseTerminal={() => {}} />
    </AppAtomRegistryProvider>,
  );
  const options = fixture.surfaceOptions.at(-1)!;
  const validation = options.validateLink!("src/pending.ts");
  await act(() => options.onLinkHover!("src/pending.ts"));
  fixture.deniedScopes.add(AuthFilesystemReadScope);
  await act(() => {
    appAtomRegistry.set(pending, AsyncResult.success({ kind: "file" }));
  });
  expect(await validation).toBe(false);
  expect(options.canActivateLink!("src/pending.ts")).toBe(false);
});
