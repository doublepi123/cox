import { createMemoryHistory } from "@tanstack/react-router";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "./ThreadRouteView";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { draftSendState } from "./chat/chatViewSend";

const threadStreamFailure = vi.hoisted(() => ({
  threadId: null as string | null,
  kind: "empty" as "empty" | "cached",
  delivered: new Set<string>(),
}));

const compression = vi.hoisted(() => ({ gate: null as Promise<void> | null }));
vi.mock(import("~/lib/imageCompression"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    prepareImageForAttachment: async (...args) => {
      await compression.gate;
      return actual.prepareImageForAttachment(...args);
    },
  };
});

const rejectSend = vi.hoisted(() => ({ pending: null as (() => void) | null, enabled: false }));

const sendGate = vi.hoisted(() => ({
  started: false,
  completion: null as Promise<void> | null,
  runTransitionUpdate: null as (() => void | Promise<void>) | null,
  promptRef: null as { current: string } | null,
}));

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer, Effect, Stream, contracts] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
    import("effect/Effect"),
    import("effect/Stream"),
    import("@t3tools/contracts"),
  ]);
  const streamFailure = new Error("stream failed");
  const failingClient = (client: WsRpcProtocolClient): WsRpcProtocolClient =>
    new Proxy(client, {
      get: (target, property, receiver) => {
        const method = Reflect.get(target, property, receiver) as unknown;
        if (typeof method !== "function") return method;
        if (property === contracts.ORCHESTRATION_V2_WS_METHODS.dispatchCommand) {
          return (command: import("@t3tools/contracts").OrchestrationV2Command) =>
            rejectSend.enabled && command.type === "message.dispatch"
              ? Effect.callback<
                  { sequence: number },
                  InstanceType<typeof contracts.OrchestrationV2DispatchCommandError>
                >((resume) => {
                  rejectSend.pending = () =>
                    resume(
                      Effect.fail(
                        new contracts.OrchestrationV2DispatchCommandError({
                          commandId: command.commandId,
                          commandType: command.type,
                          message: "The server rejected this send.",
                        }),
                      ),
                    );
                })
              : Effect.succeed({ sequence: 1 });
        }
        if (property === contracts.ORCHESTRATION_V2_WS_METHODS.launchThread) {
          return (input: { readonly threadId: ThreadId }) => {
            const projection = makeThreadProjectionFixture();
            return Effect.succeed({
              threadId: input.threadId,
              projection: {
                ...projection,
                thread: { ...projection.thread, id: input.threadId },
              },
              resumed: false,
              sequence: 1,
            });
          };
        }
        if (property !== contracts.ORCHESTRATION_V2_WS_METHODS.subscribeThread) return method;
        return (input: { readonly threadId: ThreadId }) => {
          const stream = method(input);
          if (input.threadId !== threadStreamFailure.threadId) return stream;
          if (
            threadStreamFailure.kind === "cached" &&
            !threadStreamFailure.delivered.has(input.threadId)
          ) {
            threadStreamFailure.delivered.add(input.threadId);
            return Stream.concat(stream.pipe(Stream.take(2)), Stream.fail(streamFailure));
          }
          return Stream.fail(streamFailure);
        };
      },
    });
  const driver: FakeDriver = {
    ...fakeDriver,
    connect: (entry) =>
      Effect.map(fakeDriver.connect(entry), (lease) => ({
        ...lease,
        session: { ...lease.session, client: failingClient(lease.session.client) },
      })),
  };
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, driver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("./chat/draftHeroTransition"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    runMobileComposerTransition: (
      update: () => void | Promise<void>,
      options: Parameters<typeof actual.runMobileComposerTransition>[1],
    ) => {
      const completion = sendGate.completion;
      if (completion === null) return actual.runMobileComposerTransition(update, options);
      sendGate.started = true;
      sendGate.runTransitionUpdate = update;
      return completion;
    },
  };
});

vi.mock(import("./chat/useComposerSend"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useComposerSend: (input: Parameters<typeof actual.useComposerSend>[0]) => {
      sendGate.promptRef = input.promptRef;
      return actual.useComposerSend(input);
    },
  };
});

installFakeEnvironment([
  threadWithHistory("thread-stream-empty", 1),
  threadWithHistory("thread-stream-cached", 1),
  threadWithHistory("thread-send-destination", 1),
  threadWithHistory("thread-rejected-send", 1),
  threadWithHistory("thread-held-image-send", 1),
]);

function isolateComposerDrafts(): Disposable {
  const reset = () => {
    useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
    useComposerDraftStore.persist.clearStorage();
  };
  reset();
  return { [Symbol.dispose]: reset };
}

const returningUserSettings = () =>
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });

const failThreadStream = (threadId: ThreadId, kind: "empty" | "cached") => {
  threadStreamFailure.threadId = threadId;
  threadStreamFailure.kind = kind;
  threadStreamFailure.delivered.clear();
  return {
    [Symbol.dispose]() {
      threadStreamFailure.threadId = null;
      threadStreamFailure.delivered.clear();
    },
  };
};

async function mountThread(threadId: ThreadId) {
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${threadId}`] }),
  );
  await router.load();
  return render(<AppRoot router={router} />, { router: false });
}

const streamError = () => page.getByText("stream failed");
const composerSyncStatus = () => document.querySelector("[data-composer-sync-status]");

const recoverThreadStream = async () => {
  threadStreamFailure.threadId = null;
  await act(() => window.dispatchEvent(new Event("focus")));
  await vi.waitFor(() => expect(streamError().query()).toBeNull(), {
    interval: 50,
    timeout: 10_000,
  });
};

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _drafts = isolateComposerDrafts();
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

it("a thread without detail shows its stored stream failure instead of loading text", async () => {
  using _drafts = isolateComposerDrafts();
  const threadId = ThreadId.make("thread-stream-empty");
  using _stream = failThreadStream(threadId, "empty");
  returningUserSettings();
  await using _app = await mountThread(threadId);

  await expect.element(streamError(), { timeout: 10_000 }).toBeVisible();
  expect(composerSyncStatus()).toBeNull();

  await recoverThreadStream();
  await expect.element(page.getByText(`Answer 0 for ${threadId}.`)).toBeVisible();
});

it("a thread with cached detail shows its stored stream failure instead of sync text", async () => {
  using _drafts = isolateComposerDrafts();
  const threadId = ThreadId.make("thread-stream-cached");
  using _stream = failThreadStream(threadId, "cached");
  returningUserSettings();
  await using _app = await mountThread(threadId);

  await expect
    .element(page.getByText(`Answer 0 for ${threadId}.`), { timeout: 10_000 })
    .toBeVisible();
  await expect.element(streamError(), { timeout: 10_000 }).toBeVisible();
  expect(composerSyncStatus()).toBeNull();

  await recoverThreadStream();
});

it("removes a rejected optimistic message and keeps the new draft", async () => {
  using _drafts = isolateComposerDrafts();
  returningUserSettings();
  rejectSend.enabled = true;
  try {
    await using _app = await mountThread(ThreadId.make("thread-rejected-send"));
    await expect.element(page.getByText("Answer 0 for thread-rejected-send.")).toBeVisible();
    const editor = page.getByTestId("composer-editor");
    await userEvent.click(editor);
    await userEvent.keyboard("Rejected prompt{Enter}");
    await vi.waitFor(() => expect(rejectSend.pending).not.toBeNull());
    await expect.element(page.getByText("Rejected prompt", { exact: true })).toBeVisible();
    await userEvent.keyboard("New draft");
    rejectSend.pending?.();
    await expect.element(page.getByText("The server rejected this send.")).toBeVisible();
    await expect
      .element(page.getByText("Rejected prompt", { exact: true }))
      .not.toBeInTheDocument();
    expect(editor.element().textContent).toContain("New draft");
  } finally {
    rejectSend.enabled = false;
    rejectSend.pending = null;
  }
});

it("a send finishing after navigation leaves the open thread's composer alone", async () => {
  using _drafts = isolateComposerDrafts();
  returningUserSettings();
  const origin = ThreadId.make("thread-send-origin");
  const draftId = DraftId.make("draft-send-origin");
  const destination = ThreadId.make("thread-send-destination");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: origin,
    });
  let finishTransition = () => {};
  const completion = new Promise<void>((resolve) => {
    finishTransition = resolve;
  });
  sendGate.started = false;
  sendGate.completion = completion;
  using _sendGate = {
    [Symbol.dispose]() {
      sendGate.started = false;
      sendGate.completion = null;
      sendGate.runTransitionUpdate = null;
      sendGate.promptRef = null;
    },
  };
  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, { router: false });
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  await userEvent.click(editor);
  await userEvent.type(editor, "origin message");
  await userEvent.click(page.getByRole("button", { name: "Submit message", exact: true }));
  const originRouteKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT_ID, origin));
  await vi.waitFor(() => {
    expect(draftSendState(originRouteKey).sendInFlight.current).toBe(true);
    expect(sendGate.started).toBe(true);
  });

  await act(() => router.navigate({ href: `/${ENVIRONMENT_ID}/${destination}` }));
  await expect.element(page.getByText(`Answer 0 for ${destination}.`)).toBeVisible();
  await userEvent.click(editor);
  await userEvent.type(editor, "destination draft");
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(editor).toHaveTextContent("destination draft");
  const cursor = window.getSelection()?.anchorOffset;
  expect(cursor).toBe("destination draft".length - 1);

  await act(async () => {
    const update = sendGate.runTransitionUpdate;
    if (update === null) throw new Error("Draft transition did not start");
    await update();
    finishTransition();
  });
  await vi.waitFor(() => expect(draftSendState(originRouteKey).sendInFlight.current).toBe(false));
  expect(sendGate.promptRef?.current).toBe("destination draft");
  await expect.element(editor).toHaveTextContent("destination draft");
  expect(window.getSelection()?.anchorOffset).toBe(cursor);
  expect(
    useComposerDraftStore.getState().getComposerDraft(scopeThreadRef(ENVIRONMENT_ID, destination))
      ?.prompt,
  ).toBe("destination draft");
});

it("holds Enter while an image compresses and cancels on edit or Escape", async () => {
  using _drafts = isolateComposerDrafts();
  returningUserSettings();
  let finishCompression!: () => void;
  compression.gate = new Promise<void>((resolve) => {
    finishCompression = resolve;
  });
  using _compression = {
    [Symbol.dispose]: () => {
      compression.gate = null;
      finishCompression();
    },
  };
  await using _app = await mountThread(ThreadId.make("thread-held-image-send"));
  const editor = page.getByTestId("composer-editor");
  await expect.element(editor).toBeVisible();
  await expect.element(page.getByText("Answer 0 for thread-held-image-send.")).toBeVisible();
  await userEvent.click(editor);
  const png = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    ),
    (character) => character.charCodeAt(0),
  );
  const clipboardData = new DataTransfer();
  clipboardData.items.add(new File([png], "shot.png", { type: "image/png" }));
  editor
    .element()
    .dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  await userEvent.keyboard("check image{Enter}");
  const waiting = page.getByText("Sending once image is ready");
  await expect.element(waiting).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Sending when ready" }))
    .toHaveAttribute("aria-busy", "true");
  await userEvent.keyboard(" now");
  await expect.element(waiting).not.toBeInTheDocument();
  await expect.element(editor).toHaveTextContent("check image now");
  await userEvent.keyboard("{Enter}");
  await expect.element(waiting).toBeVisible();
  await userEvent.keyboard("{Escape}");
  await expect.element(waiting).not.toBeInTheDocument();
});

it("opening Settings without a page event closes the composer model picker and permissions menu", async () => {
  using _environment = installFakeEnvironment([]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-29219");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
      threadId: ThreadId.make("thread-29219"),
    });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  const trigger = document.querySelector<HTMLElement>("[data-chat-provider-model-picker]");
  if (!trigger) throw new Error("composer model picker trigger missing");
  await userEvent.click(trigger);
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toBeVisible();

  // The desktop menu's open-settings accelerator navigates with no key or pointer event in the page.
  await act(() => router.navigate({ to: "/settings" }));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.element(search).not.toBeInTheDocument();

  await act(() => router.navigate({ to: "/draft/$draftId", params: { draftId } }));
  await page.getByRole("button", { name: /^Permissions: / }).click();
  // The modal Settings dialog aria-hides everything outside it, so match text, not role.
  const permissions = page.getByText("Allow commands and edits without prompts.").last();
  await expect.element(permissions).toBeVisible();
  await act(() => router.navigate({ to: "/settings" }));
  await expect.element(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await expect.element(permissions).not.toBeInTheDocument();
});
