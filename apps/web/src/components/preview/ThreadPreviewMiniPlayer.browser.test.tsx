import {
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { ChatCanvasContext } from "../chat/ChatCanvasContext";
import { resolveChatCanvasLayout } from "../chat/chatCanvasLayout";
import {
  browserMiniPlayerSource,
  previewMiniPlayerSourceKey,
  usePreviewMiniPlayerStore,
} from "~/previewMiniPlayerStore";
import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";

vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "http://preview.test",
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  useThreadPreviewState: (() => ({
    serverEpoch: null,
    sessions: {
      "tab-1": {
        runtime: "server",
        navStatus: { _tag: "Success", url: "http://example.com/" },
        viewport: FILL_PREVIEW_VIEWPORT,
        zoomFactor: 1,
      },
    },
  })) as never,
}));
vi.mock(import("~/browser/ServerBrowserSurface"), () => ({
  ServerBrowserSurface: () => <div data-testid="Server browser" />,
}));
vi.mock(import("~/browser/serverPictureInPicture"), () => ({
  useServerPictureInPictureKey: () => null,
  serverPictureInPictureKey: () => "inactive",
  supportsServerPictureInPicture: () => false,
  openServerPictureInPicture: vi.fn(),
  closeServerPictureInPicture: vi.fn(),
}));

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const container = { width: 390, height: 844 };
const miniPlayer = {
  source: browserMiniPlayerSource("tab-1"),
  position: null,
  width: 320,
  lastInteraction: "drag" as const,
};
const preview = {
  key: previewMiniPlayerSourceKey(miniPlayer.source),
  width: miniPlayer.width,
  position: miniPlayer.position,
  source: { width: 1280, height: 720 },
  lastInteraction: miniPlayer.lastInteraction,
};

function Player() {
  return (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 16, minChatWidth: 280 },
        layout: resolveChatCanvasLayout({ container, preview, padding: 16, minChatWidth: 280 }),
        previewKey: preview.key,
        registerTimeline: () => {},
        measureDetailsCard: () => {},
        detailsCardTopInset: 0,
        preferredDetailsCard: null,
        detailsCardPlacement: null,
      }}
    >
      <ThreadPreviewMiniPlayer threadRef={threadRef} miniPlayer={miniPlayer} />
    </ChatCanvasContext>
  );
}

describe("mobile floating browser preview", () => {
  it("keeps preview actions visible and touch-sized", async () => {
    await page.viewport(390, 844);
    usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
    await using _screen = await render(<Player />, { router: false });
    const actions = page.getByRole("group", { name: "Browser preview actions", exact: true });
    expect(getComputedStyle(actions.element()).opacity).toBe("1");
    for (const name of ["Open preview in panel", "Close floating preview"]) {
      const rect = page
        .getByRole("button", { name, exact: true })
        .element()
        .getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "Close floating preview", exact: true }).click();
    expect(usePreviewMiniPlayerStore.getState().byThreadKey).toEqual({});
  });
});
