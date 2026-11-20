import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import "../../index.css";

it.each([390, 1280])("keeps multiline stop reasons visible at %d pixels", async (width) => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 800);
  try {
    const reason =
      "beforeTurn hook (project): Review the checks before continuing.\nThe second check also needs attention.";
    await using screen = await render(
      <TimelineSystemDivider label="Run interrupted" detail={reason} wrapDetail />,
    );
    const detail = screen.getByText("The second check also needs attention.", { exact: false });
    await expect.element(detail).toBeVisible();
    const element = detail.element();
    expect(getComputedStyle(element).whiteSpace).toBe("pre-wrap");
    expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
  } finally {
    await page.viewport(viewport.width, viewport.height);
  }
});
