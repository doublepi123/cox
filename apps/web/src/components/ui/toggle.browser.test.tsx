import "~/index.css";
import { expect, it } from "vite-plus/test";
import { act, render } from "../../../test/render";
import { applyAppearanceContrast } from "../../appearanceContrast";
import { Toggle } from "./toggle";

it("changes a pressed ghost toggle's background as appearance contrast increases", async () => {
  await using screen = await render(
    <Toggle variant="ghost" pressed aria-label="Toggle thread details panel" />,
  );
  const button = screen.getByRole("button", { name: "Toggle thread details panel", pressed: true });
  try {
    await act(() => applyAppearanceContrast(document.documentElement, 100));
    const initial = getComputedStyle(button.element()).backgroundColor;
    await act(() => applyAppearanceContrast(document.documentElement, 200));
    expect(getComputedStyle(button.element()).backgroundColor).not.toBe(initial);
  } finally {
    applyAppearanceContrast(document.documentElement, 100);
  }
});
