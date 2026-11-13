import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "./ThreadRouteView";

import { AppRoot } from "~/AppRoot";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

const threadStreamFailure = vi.hoisted(() => ({
  threadId: null as string | null,
  kind: "empty" as "empty" | "cached",
  delivered: new Set<string>(),
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
        if (
          property !== contracts.ORCHESTRATION_V2_WS_METHODS.subscribeThread ||
          typeof method !== "function"
        ) {
          return method;
        }
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

installFakeEnvironment([
  threadWithHistory("thread-stream-empty", 1),
  threadWithHistory("thread-stream-cached", 1),
]);

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
