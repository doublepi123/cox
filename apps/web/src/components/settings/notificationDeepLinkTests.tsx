import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";
import { cdp } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { startNotificationDeepLinkNavigation } from "../../pwa/notificationDeepLinks";

export function notificationDeepLinkTests() {
  it("opens thread URLs from the real service worker notificationclick without Client.postMessage errors", async () => {
    const root = createRootRoute();
    const thread = createRoute({
      getParentRoute: () => root,
      path: "/$environmentId/$threadId",
      component: () => <h1>Thread route</h1>,
    });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "/settings/notifications",
      component: () => <h1>Notifications route</h1>,
    });
    const router = createRouter({
      routeTree: root.addChildren([thread, settings]),
      history: createMemoryHistory({ initialEntries: ["/settings/notifications"] }),
      disableGlobalCatchBoundary: true,
    });
    await router.load();
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    using _listener = { [Symbol.dispose]: startNotificationDeepLinkNavigation(router) };
    const registration = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const session = cdp();
    const { targetInfos } = await session.send("Target.getTargets");
    const worker = targetInfos.find(
      (target) =>
        target.type === "service_worker" && target.url === new URL("/sw.js", location.origin).href,
    );
    expect(worker).toBeDefined();
    if (!worker) return;
    const { sessionId } = await session.send("Target.attachToTarget", {
      targetId: worker.targetId,
      flatten: false,
    });
    const messages: unknown[] = [];
    const capture = (event: MessageEvent) => messages.push(event.data);
    const forward = (event: MessageEvent) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: event.data }));
    };
    navigator.serviceWorker.addEventListener("message", capture);
    window.top?.navigator.serviceWorker.addEventListener("message", forward);
    try {
      const reply = new Promise<unknown>((resolve) => {
        session.on("Target.receivedMessageFromTarget", ({ message }) => {
          const parsed: unknown = JSON.parse(message);
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "id" in parsed &&
            parsed.id === 1
          ) {
            resolve(parsed);
          }
        });
      });
      await session.send("Target.sendMessageToTarget", {
        sessionId,
        message: JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: {
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
            expression: `(async () => {
              const originalFocus = WindowClient.prototype.focus;
              WindowClient.prototype.focus = async function() { return this; };
              let completion;
              const event = new Event("notificationclick");
              Object.defineProperty(event, "notification", { value: { close() {}, data: { threadPath: "/env-1/thread-42" } } });
              Object.defineProperty(event, "waitUntil", { value(promise) { completion = promise; } });
              try {
                self.dispatchEvent(event);
                await completion;
              } finally {
                WindowClient.prototype.focus = originalFocus;
              }
              return "notificationclick delivered";
            })()`,
          },
        }),
      });
      const result = await reply;
      expect(result).not.toHaveProperty("result.exceptionDetails");
      expect(result).toMatchObject({
        result: { result: { value: "notificationclick delivered" } },
      });
      await expect.poll(() => router.state.location.pathname).toBe("/env-1/thread-42");
      await expect.element(screen.getByRole("heading", { name: "Thread route" })).toBeVisible();
      expect(messages).toContainEqual({
        type: "cox:navigate-thread",
        threadPath: "/env-1/thread-42",
      });
      for (const threadPath of [
        "https://evil.example/env/thread",
        "//evil.example/env/thread",
        "/settings/notifications",
        "/env/thread/extra",
        "/env/%2Fetc",
      ]) {
        await act(() =>
          navigator.serviceWorker.dispatchEvent(
            new MessageEvent("message", { data: { type: "cox:navigate-thread", threadPath } }),
          ),
        );
        expect(router.state.location.pathname).toBe("/env-1/thread-42");
      }
    } finally {
      window.top?.navigator.serviceWorker.removeEventListener("message", forward);
      navigator.serviceWorker.removeEventListener("message", capture);
      await session.send("Target.detachFromTarget", { sessionId });
      await registration.unregister();
    }
  });
}
