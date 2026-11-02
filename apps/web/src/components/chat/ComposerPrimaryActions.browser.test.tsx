import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));

function setup(overrides: Partial<ComponentProps<typeof ComposerPrimaryActions>> = {}) {
  const onSubmitMessage = vi.fn();
  const onDispatchMessage = vi.fn<(mode: "queue" | "steer") => void>();
  const ui = (
    <ComposerPrimaryActions
      compact
      canOperateThread
      pendingAction={null}
      isRunning
      canInterrupt
      showPlanFollowUpPrompt={false}
      promptHasText
      isSendBusy={false}
      sendDisabledReason={null}
      isEnvironmentUnavailable={false}
      isPreparingWorktree={false}
      hasSendableContent
      onSubmitMessage={(event) => {
        event.preventDefault();
        onSubmitMessage();
      }}
      onDispatchMessage={onDispatchMessage}
      onPreviousPendingQuestion={() => {}}
      onInterrupt={() => {}}
      onImplementPlanInNewThread={() => {}}
      {...overrides}
    />
  );
  return { ui, onSubmitMessage, onDispatchMessage };
}

describe("composer follow-up actions", () => {
  it("defaults to queueing and offers immediate steering without keyboard modifiers", async () => {
    const { ui, onSubmitMessage, onDispatchMessage } = setup();
    await using screen = await render(ui);
    await screen.getByRole("button", { name: "Queue message", exact: true }).click();
    expect(onSubmitMessage).toHaveBeenCalledOnce();
    expect(onDispatchMessage).not.toHaveBeenCalled();

    await screen.getByRole("button", { name: "Message send options" }).click();
    await page.getByRole("menuitem", { name: "Steer now" }).click();
    expect(onDispatchMessage).toHaveBeenCalledExactlyOnceWith("steer");
    expect(onSubmitMessage).toHaveBeenCalledOnce();
  });

  it("can explicitly queue even when the saved preference is steering", async () => {
    const { ui, onDispatchMessage } = setup({ followUpBehavior: "steer" });
    await using screen = await render(ui);
    await expect.element(screen.getByRole("button", { name: "Steer message" })).toBeVisible();
    await screen.getByRole("button", { name: "Message send options" }).click();
    await page.getByRole("menuitem", { name: "Queue message" }).click();
    expect(onDispatchMessage).toHaveBeenCalledExactlyOnceWith("queue");
  });

  it("disables immediate steering when the active turn cannot accept input", async () => {
    const { ui, onDispatchMessage } = setup({ canSteer: false });
    await using screen = await render(ui);
    await expect.element(screen.getByRole("button", { name: "Queue message" })).toBeVisible();
    await screen.getByRole("button", { name: "Message send options" }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Steer now" }))
      .toHaveAttribute("aria-disabled", "true");
    await page.getByRole("menuitem", { name: "Queue message" }).click();
    expect(onDispatchMessage).toHaveBeenCalledExactlyOnceWith("queue");
  });

  it.each([{ isRunning: false }, { isEditingQueuedMessage: true }])(
    "does not offer dispatch choices outside a new follow-up: %o",
    async (overrides) => {
      const { ui } = setup(overrides);
      await using screen = await render(ui);
      await expect
        .element(screen.getByRole("button", { name: "Message send options" }))
        .not.toBeInTheDocument();
    },
  );

  it("does not allow dispatch through the menu while sending is disabled", async () => {
    const { ui } = setup({ isSendBusy: true });
    await using screen = await render(ui);
    await expect
      .element(screen.getByRole("button", { name: "Message send options" }))
      .toBeDisabled();
  });
});
