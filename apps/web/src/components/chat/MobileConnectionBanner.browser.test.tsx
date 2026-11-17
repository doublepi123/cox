import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { subscribeToApplicationWakeups } from "../../connection/platform";
import { MobileConnectionBanner } from "./MobileConnectionBanner";
import "../../index.css";

it("offers immediate runtime recovery during reconnect and missed-event replay", async () => {
  await page.viewport(390, 844);
  const reasons: string[] = [];
  const unsubscribe = subscribeToApplicationWakeups((reason) => reasons.push(reason));
  await using screen = await render(<MobileConnectionBanner reconnecting syncing={false} />);
  try {
    await expect.element(screen.getByText("Reconnecting", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Retry now" }).click();
    expect(reasons).toContain("network-changed");
    await screen.rerender(<MobileConnectionBanner reconnecting={false} syncing />);
    await expect
      .element(screen.getByText("Syncing missed events...", { exact: true }))
      .toBeVisible();
    await page.screenshot({ path: "../../../../../.omo/evidence/task-12-reconnecting-mobile.png" });
    await page.viewport(1280, 800);
    await expect
      .element(screen.getByText("Syncing missed events...", { exact: true }))
      .not.toBeVisible();
    await page.screenshot({
      path: "../../../../../.omo/evidence/task-12-reconnecting-desktop.png",
    });
    await screen.rerender(<MobileConnectionBanner reconnecting={false} syncing={false} />);
    await expect.element(screen.getByRole("status")).not.toBeInTheDocument();
  } finally {
    unsubscribe();
    await page.viewport(1280, 800);
  }
});
