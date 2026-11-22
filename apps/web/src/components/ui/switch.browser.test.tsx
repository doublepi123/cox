import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { Switch } from "./switch";

import "~/index.css";

it("can set a mixed switch off when the environment dropped the previous change", async () => {
  const onCheckedChange = vi.fn();
  await using screen = await render(
    <Switch aria-label="Auto-pull" checked={false} mixed onCheckedChange={onCheckedChange} />,
  );
  const toggle = screen.getByRole("switch", { name: "Auto-pull" });
  await expect.element(toggle).toHaveAttribute("aria-checked", "mixed");
  await userEvent.click(toggle);
  await userEvent.click(toggle);
  expect(onCheckedChange.mock.calls.map(([checked]) => checked)).toEqual([true, false]);
});
