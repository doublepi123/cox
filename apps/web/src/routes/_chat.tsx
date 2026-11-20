import { Outlet, createFileRoute } from "@tanstack/react-router";
import { useServerPreviewSessions } from "../components/preview/usePreviewSession";
import { usePrimaryEnvironmentId } from "../state/environments";

import { ThreadRouteView } from "../components/ThreadRouteView";
import { isAppModalPage } from "../components/sidebar/mainAppLocation";
import { SidebarInset } from "../components/ui/sidebar";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { retainThreadFindForRoute } from "../components/chat/threadFindStore";
import { ThreadLinkPrompt } from "../components/promptLinks/ThreadLinkPrompt";
import { useShownThreadRouteTarget } from "../hooks/useShownThreadRouteTarget";
import { isDesktopPageWindow } from "../lib/desktopSettingsNavigation";

function ChatRouteLayout() {
  if (isDesktopPageWindow(window.coxDesktop)) return <Outlet />;
  return <MainChatRouteLayout />;
}

function MainChatRouteLayout() {
  useServerPreviewSessions(usePrimaryEnvironmentId());
  // Render both routes here so draft promotion keeps the same ChatView mounted.
  const { shownTarget, modalOpen } = useShownThreadRouteTarget();
  return (
    <>
      {shownTarget?.kind === "server" && !modalOpen ? (
        <ThreadLinkPrompt threadRef={shownTarget.threadRef} />
      ) : null}
      {shownTarget ? (
        <ThreadRouteView target={shownTarget} background={modalOpen} />
      ) : modalOpen ? (
        <div className="flex h-dvh flex-1">
          <SidebarInset />
        </div>
      ) : (
        <Outlet />
      )}
      {modalOpen ? <Outlet /> : null}
    </>
  );
}

export const Route = createFileRoute("/_chat")({
  beforeLoad: async ({ location }) => {
    return { appModalPage: isAppModalPage(location.pathname) };
  },
  component: ChatRouteLayout,
  // Every match carries the whole location's params, so this layout sees the thread route's too.
  onEnter: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onStay: ({ context, params }) => retainThreadFindForRouteMatch(context.appModalPage, params),
  onLeave: () => retainThreadFindForRoute({ modalPage: false, threadRef: null }),
});

function retainThreadFindForRouteMatch(
  modalPage: boolean,
  params: Partial<Record<"environmentId" | "threadId", string>>,
) {
  const target = resolveThreadRouteTarget(params);
  retainThreadFindForRoute({
    modalPage,
    threadRef: target?.kind === "server" ? target.threadRef : null,
  });
}
