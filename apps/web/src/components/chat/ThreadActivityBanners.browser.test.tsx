import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { extensionStatusBannerItem } from "./ThreadActivityBanners";

const SIGNATURE = { key: "  omo-native", text: "(OmO Native by Q Kim)" };

function stack(statuses: Parameters<typeof extensionStatusBannerItem>[0]) {
  const item = extensionStatusBannerItem(statuses, "OMO Native");
  return <ComposerBannerStack items={item ? [item] : []} />;
}

it("leaves out the strip when the provider reports no extension status", () => {
  expect(extensionStatusBannerItem([], "OMO Native")).toBeNull();
});

it("leaves out the strip when only the signature and an idle memory status remain", () => {
  expect(
    extensionStatusBannerItem(
      [SIGNATURE, { key: "memory", text: "mem:cox-global-528141c7 just now (+7)" }],
      "OMO Native",
    ),
  ).toBeNull();
});

it("shows the first visible status and discloses all of them from one keyboard-operable row", async () => {
  await using screen = await render(
    stack([
      SIGNATURE,
      { key: "memory", text: "mem:x ⠋ reflecting" },
      { key: "goal", text: "Pursuing goal (3m)" },
    ]),
  );
  const trigger = screen.getByRole("button", { name: "OMO Native extension status" });
  await expect.element(trigger).toHaveTextContent("Memory reflecting+1");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");

  trigger.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "true");
  const items = page.getByRole("dialog").getByRole("listitem");
  await expect
    .poll(() => items.elements().map((element) => element.textContent))
    .toEqual(["Memory reflecting", "Pursuing goal (3m)"]);

  await userEvent.keyboard("{Escape}");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await expect.poll(() => document.activeElement).toBe(trigger.element());
});

it("stays closed when the statuses change while focus is elsewhere", async () => {
  await using screen = await render(stack([{ key: "goal", text: "Pursuing goal (3m)" }]));
  const trigger = screen.getByRole("button", { name: "OMO Native extension status" });
  await expect.element(trigger).toHaveTextContent("Pursuing goal (3m)");

  await screen.rerender(
    stack([
      { key: "goal", text: "Pursuing goal (4m)" },
      { key: "ulw-loop", text: "⚡ ultraworking..." },
    ]),
  );
  await expect.element(trigger).toHaveTextContent("Pursuing goal (4m)+1");
  expect(document.activeElement).not.toBe(trigger.element());
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  expect(page.getByRole("dialog").elements()).toHaveLength(0);
});
