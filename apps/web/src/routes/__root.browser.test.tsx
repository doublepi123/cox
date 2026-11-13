import type { AuthSessionState } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { Route } from "./__root";

const mocks = vi.hoisted(() => ({
  resolveInitialServerAuthGateState: vi.fn(),
  invalidateServerAuthGate: vi.fn(),
  usePrimarySessionState: vi.fn(),
}));

vi.mock("../environments/primary/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../environments/primary/auth")>()),
  resolveInitialServerAuthGateState: mocks.resolveInitialServerAuthGateState,
  invalidateServerAuthGate: mocks.invalidateServerAuthGate,
}));
vi.mock("../environments/primary/sessionState", () => ({
  usePrimarySessionState: mocks.usePrimarySessionState,
}));
vi.mock("../observability/clientTracing", () => ({
  configureClientTracing: vi.fn(),
}));
vi.mock("../lib/desktopSettingsNavigation", () => ({
  isDesktopPageWindow: () => true,
}));
vi.mock("../components/ConfirmDialogHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ConfirmDialogHost")>()),
  ConfirmDialogHost: () => null,
}));
vi.mock("../components/CustomSnoozeDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/CustomSnoozeDialog")>()),
  CustomSnoozeDialogHost: () => null,
}));
vi.mock("../components/ThreadProjectMoveDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/ThreadProjectMoveDialog")>()),
  ThreadProjectMoveDialogHost: () => null,
}));
vi.mock("../components/settings/ThemeEditorHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/settings/ThemeEditorHost")>()),
  ThemeEditorHost: () => null,
}));

const PASSWORD_AUTH = {
  policy: "loopback-browser",
  loginMode: "password",
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "cox_session",
} as const;
const authenticatedSession: AuthSessionState = {
  authenticated: true,
  auth: PASSWORD_AUTH,
};
const revokedSession: AuthSessionState = {
  authenticated: false,
  auth: PASSWORD_AUTH,
};

function sessionView(data: AuthSessionState | null, error: string | null = null) {
  return { data, error, isPending: false, refresh: () => {} };
}

let currentSessionView = sessionView(authenticatedSession);
const sessionListeners = new Set<() => void>();

function subscribeToSession(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

function useMockPrimarySessionState() {
  return useSyncExternalStore(subscribeToSession, () => currentSessionView);
}

function setSessionView(view: typeof currentSessionView): void {
  currentSessionView = view;
  for (const listener of sessionListeners) listener();
}

function mockRootSession(): Disposable {
  mocks.resolveInitialServerAuthGateState.mockReset();
  mocks.invalidateServerAuthGate.mockReset();
  mocks.usePrimarySessionState.mockReset();
  mocks.usePrimarySessionState.mockImplementation(useMockPrimarySessionState);
  currentSessionView = sessionView(authenticatedSession);
  sessionListeners.clear();
  return {
    [Symbol.dispose]() {
      sessionListeners.clear();
      mocks.usePrimarySessionState.mockReset();
    },
  };
}

describe("root authentication gate", () => {
  it("shows login after the primary session is revoked", async () => {
    using _session = mockRootSession();
    mocks.resolveInitialServerAuthGateState
      .mockResolvedValueOnce({ status: "authenticated" })
      .mockResolvedValueOnce({ status: "requires-auth", auth: PASSWORD_AUTH });
    const indexRoute = createRoute({
      getParentRoute: () => Route,
      path: "/",
      component: () => <h1>Authenticated app</h1>,
    });
    const router = createRouter({
      routeTree: Route.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      disableGlobalCatchBoundary: true,
    });
    await router.load();
    await using screen = await render(<RouterProvider router={router} />, { router: false });
    await expect
      .element(screen.getByRole("heading", { name: "Sign in to Cox" }))
      .not.toBeInTheDocument();

    await act(() => setSessionView(sessionView(revokedSession)));

    await expect.poll(() => mocks.invalidateServerAuthGate.mock.calls.length).toBe(1);
    await expect.poll(() => mocks.resolveInitialServerAuthGateState.mock.calls.length).toBe(2);
    await expect.element(screen.getByRole("heading", { name: "Sign in to Cox" })).toBeVisible();
  });

  it("keeps the authenticated gate during a transient session read failure", async () => {
    using _session = mockRootSession();
    mocks.resolveInitialServerAuthGateState.mockResolvedValue({ status: "authenticated" });
    const indexRoute = createRoute({
      getParentRoute: () => Route,
      path: "/",
      component: () => <h1>Authenticated app</h1>,
    });
    const router = createRouter({
      routeTree: Route.addChildren([indexRoute]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
      disableGlobalCatchBoundary: true,
    });
    await router.load();
    await using screen = await render(<RouterProvider router={router} />, { router: false });

    await act(() =>
      setSessionView(sessionView(authenticatedSession, "Could not read environment session.")),
    );

    await expect
      .element(screen.getByRole("heading", { name: "Sign in to Cox" }))
      .not.toBeInTheDocument();
    expect(mocks.invalidateServerAuthGate).not.toHaveBeenCalled();
    expect(mocks.resolveInitialServerAuthGateState).toHaveBeenCalledOnce();
  });
});
