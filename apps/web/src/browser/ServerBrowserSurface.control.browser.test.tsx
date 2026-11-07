import { EnvironmentId } from "@t3tools/contracts";
import type {
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn<(target: unknown, handlers: PreviewStreamEvents) => unknown>(),
  sent: [] as PreviewStreamInput[],
  access: { url: "ws://preview.test", token: "test" },
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: mocks.createClient as never,
  createPreviewFramePainter: () => ({ paint: () => undefined, stop: () => undefined }),
}));
vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

it("makes agent handoff a primary touch-sized action", async () => {
  mocks.sent.length = 0;
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: (input: PreviewStreamInput) => mocks.sent.push(input),
    stop: () => undefined,
  }));
  await page.viewport(390, 740);
  const container = document.createElement("div");
  container.style.cssText = "width: 390px; height: 500px; display: flex;";
  await using screen = await render(
    <ServerBrowserSurface
      environmentId={EnvironmentId.make("environment-control")}
      threadId="thread-control"
      tabId="tab-control"
      visible
      followSize={false}
      className="flex-1"
    />,
    { container },
  );
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const handlers = mocks.createClient.mock.calls.at(-1)![1];
  await act(() =>
    handlers.onControl?.({ canOperate: true, controller: "agent", generation: 1, dialog: null }),
  );
  const button = screen.getByRole("button", { name: "Take control", exact: true });
  const rect = button.element().getBoundingClientRect();
  expect(rect.width).toBeGreaterThanOrEqual(44);
  expect(rect.height).toBeGreaterThanOrEqual(44);
  expect(button.element().className).toContain("bg-primary");

  await button.click();
  expect(mocks.sent).toEqual([{ type: "takeControl" }]);
});
