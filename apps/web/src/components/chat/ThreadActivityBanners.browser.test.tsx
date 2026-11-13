import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { ComposerBannerStack } from "./ComposerBannerStack";
import { extensionStatusBannerItem } from "./ThreadActivityBanners";

const SIGNATURE = { key: "  omo-native", text: "(OmO Native by Q Kim)" };

it("shows the goal countdown in the full-width strip and falls back when it clears", async () => {
  const goal = { key: "goal", text: "Pursuing goal (5m)" };
  const countdown = {
    key: "goal-wait",
    text: "▰▰▰▰▱ goal continues in 22s · 1 wake source · 1 omo dag on duty",
  };
  const layout = (statuses: Parameters<typeof extensionStatusBannerItem>[0]) => (
    <div className="w-[320px] [--chat-composer-drawer-inset:0px]">{stack(statuses)}</div>
  );
  await using screen = await render(layout([goal, countdown]));
  const trigger = screen.getByRole("button", { name: "OMO Native extension status" });
  await expect.element(trigger).toHaveTextContent(countdown.text + "+1");
  expect(trigger.element().getBoundingClientRect().width).toBeGreaterThan(300);
  expect(trigger.element().scrollWidth).toBeLessThanOrEqual(trigger.element().clientWidth);
  await trigger.click();
  await expect
    .poll(() =>
      page
        .getByRole("dialog")
        .getByRole("listitem")
        .elements()
        .map((element) => element.textContent),
    )
    .toEqual([goal.text, countdown.text]);
  await userEvent.keyboard("{Escape}");
  await screen.rerender(
    layout([goal, { ...countdown, text: countdown.text.replace("22s", "21s") }]),
  );
  await expect.element(trigger).toHaveTextContent(countdown.text.replace("22s", "21s") + "+1");
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await screen.rerender(layout([goal]));
  await expect.element(trigger).toHaveTextContent(goal.text);
});

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

it("stops spinning after memory reflection and preserves the achieved goal status", async () => {
  const goal = { key: "goal", text: "Deliver a Chinese, evidence-bac… · Goal achieved (2h 12m)" };
  await using screen = await render(stack([goal, { key: "memory", text: "mem:x reflecting" }]));
  const trigger = screen.getByRole("button", { name: "OMO Native extension status" });
  expect(trigger.element().querySelector(".animate-spin")).not.toBeNull();
  await screen.rerender(stack([goal, { key: "memory", text: "mem:x 2m ago (+14)" }]));
  await expect.element(trigger).toHaveTextContent(goal.text);
  expect(trigger.element().querySelector(".animate-spin")).toBeNull();
  await trigger.click();
  await expect.element(page.getByRole("dialog").getByRole("listitem")).toHaveTextContent(goal.text);
});

it.each(["Pursuing goal (3m)", "Goal paused", "Goal achieved (2h 12m)"])(
  "does not infer running work from arbitrary extension text: %s",
  async (text) => {
    await using screen = await render(stack([{ key: "goal", text }]));
    const trigger = screen.getByRole("button", { name: "OMO Native extension status" });
    await expect.element(trigger).toHaveTextContent(text);
    expect(trigger.element().querySelector(".animate-spin")).toBeNull();
  },
);
