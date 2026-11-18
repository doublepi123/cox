import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { PopoverCreateHandle } from "../ui/popover";
import { PanelLayoutControls, WorkspaceTitlebarControls } from "./PanelLayoutControls";

const threadPanelPopoverHandle = PopoverCreateHandle();

function Controls() {
  return (
    <div className="fixed top-0 right-0 h-13">
      <PanelLayoutControls
        terminalAvailable
        terminalOpen={false}
        terminalShortcutLabel={null}
        threadPanelOpen={false}
        threadPanelPresentation="popover"
        threadPanelPopoverHandle={threadPanelPopoverHandle}
        threadPanelShortcutLabel={null}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        onToggleTerminal={vi.fn()}
        onToggleThreadPanel={vi.fn()}
        onToggleRightPanel={vi.fn()}
      />
    </div>
  );
}

describe("panel layout controls", () => {
  it("keeps floating header controls below the status bar", async () => {
    document.documentElement.style.setProperty("--cox-safe-top", "59px");
    try {
      await using screen = await render(
        <>
          <div
            data-sidebar-control
            className="fixed top-[var(--workspace-fixed-controls-top)] h-[var(--workspace-topbar-height)]"
          />
          <WorkspaceTitlebarControls
            showMaximizeControl={false}
            rightPanelOpen={false}
            animationsActive={false}
            maximized={false}
            onToggleMaximized={vi.fn()}
          >
            <button type="button">Panels</button>
          </WorkspaceTitlebarControls>
        </>,
        { router: false },
      );
      for (const selector of ["[data-workspace-titlebar-controls]", "[data-sidebar-control]"]) {
        const bar = screen.container.querySelector(selector);
        expect(bar?.getBoundingClientRect().top).toBeGreaterThanOrEqual(59);
      }
    } finally {
      document.documentElement.style.removeProperty("--cox-safe-top");
    }
  });

  it.each([320, 390, 1280])("keeps controls separate and reachable at %ipx", async (width) => {
    await page.viewport(width, 740);
    await using screen = await render(<Controls />, { router: false });
    const names = ["Toggle thread details panel", "Toggle terminal drawer", "Toggle right panel"];
    const rectangles = names.map((name) =>
      screen.getByRole("button", { name, exact: true }).element().getBoundingClientRect(),
    );
    for (const rectangle of rectangles) {
      expect(rectangle.left).toBeGreaterThanOrEqual(0);
      expect(rectangle.right).toBeLessThanOrEqual(width);
      expect(rectangle.width).toBeGreaterThanOrEqual(width < 640 ? 44 : 28);
      expect(rectangle.height).toBeGreaterThanOrEqual(width < 640 ? 44 : 28);
    }
    expect(rectangles[0]!.right).toBeLessThanOrEqual(rectangles[1]!.left);
    expect(rectangles[1]!.right).toBeLessThanOrEqual(rectangles[2]!.left);
  });
});
