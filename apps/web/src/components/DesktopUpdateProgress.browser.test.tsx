import { describe, expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { DesktopUpdateProgress } from "./DesktopUpdateProgress";

describe("desktop download progress", () => {
  it("shows byte progress and switches to an indeterminate verification phase", async () => {
    const progress = {
      phase: "downloading" as const,
      transferredBytes: 1024 * 1024,
      totalBytes: 4 * 1024 * 1024,
      bytesPerSecond: 1024 * 1024,
      remainingSeconds: 3,
    };
    await using screen = await render(<DesktopUpdateProgress progress={progress} />, {
      router: false,
    });
    await expect.element(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    expect(screen.getByRole("status").element().textContent).toContain("1.0 MB / 4.0 MB");
    expect(screen.getByRole("status").element().textContent).toContain("1.0 MB/s");
    await screen.rerender(<DesktopUpdateProgress progress={{ ...progress, phase: "verifying" }} />);
    await expect.element(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("status").element().textContent).not.toContain("MB/s");
  });

  it("keeps unknown totals indeterminate and clamps inconsistent totals", async () => {
    const progress = {
      phase: "downloading" as const,
      transferredBytes: 2048,
      totalBytes: null,
      bytesPerSecond: null,
      remainingSeconds: null,
    };
    await using screen = await render(<DesktopUpdateProgress progress={progress} />, {
      router: false,
    });
    await expect.element(screen.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    expect(screen.getByRole("status").element().textContent).toContain("2 KB");
    await screen.rerender(<DesktopUpdateProgress progress={{ ...progress, totalBytes: 1024 }} />);
    await expect.element(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
