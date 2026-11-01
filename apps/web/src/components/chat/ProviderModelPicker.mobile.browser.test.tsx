import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ComposerEffortColumn, ComposerPickerFooter } from "./ComposerModelEffort";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { runtimeModeConfig } from "./runtimeModeConfig";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const levels: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: ["Low", "Medium", "High", "Xhigh", "Max"].map((label) => ({
    id: label.toLowerCase(),
    label,
    ...(label === "Medium" ? { isDefault: true } : {}),
  })),
  currentValue: "medium",
};
const models: ReadonlyArray<ServerProviderModel> = Array.from({ length: 8 }, (_, index) => ({
  slug: `model-${index + 1}`,
  name: `Model ${index + 1}`,
  isCustom: false,
  capabilities: { optionDescriptors: [levels] },
}));
const runtimeModes = (["approval-required", "full-access"] as const).map((mode) => ({
  mode,
  ...runtimeModeConfig[mode],
}));

function Picker() {
  const [model, setModel] = useState("model-1");
  const [modelOptions, setModelOptions] = useState<
    ReadonlyArray<ProviderOptionSelection> | undefined
  >(undefined);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("approval-required");
  const traits = {
    provider: driver,
    instanceId,
    models,
    model,
    modelOptions: modelOptions ?? null,
    planModeEnabled: false,
    onModelOptionsChange: setModelOptions,
  };
  return (
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={instanceId}
      model={model}
      lockedProvider={null}
      instanceEntries={deriveProviderInstanceEntries([
        {
          instanceId,
          driver,
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-01-01T00:00:00.000Z",
          models: [...models],
          slashCommands: [],
          skills: [],
        },
      ])}
      modelOptionsByInstance={new Map([[instanceId, models]])}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={(_, selected) => setModel(selected)}
      effortColumn={<ComposerEffortColumn traits={traits} />}
      footer={
        <ComposerPickerFooter
          traits={traits}
          runtimeMode={runtimeMode}
          runtimeModeOptions={runtimeModes}
          onRuntimeModeChange={setRuntimeMode}
        />
      }
    />
  );
}

async function phoneViewport(width: number, height: number) {
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(414, 896) };
}

async function openPicker(height: number, triggerTop: number) {
  const stack = new AsyncDisposableStack();
  stack.use(await phoneViewport(400, height));
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:8px;top:${triggerTop}px`;
  stack.use(await render(<Picker />, { container }));
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
  await expect.element(page.getByRole("radio", { name: "Max" })).toBeInTheDocument();
  const popup = document.querySelector<HTMLElement>("[data-slot=popover-popup]")!;
  await expect.poll(() => popup.getAnimations({ subtree: true }).length).toBe(0);
  return {
    popup,
    viewport: popup.querySelector<HTMLElement>("[data-slot=popover-viewport]")!,
    column: popup.querySelector<HTMLElement>("[data-model-picker-effort]")!,
    list: popup.querySelector<HTMLElement>("[data-model-picker-content]")!,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

function isInside(inner: Element, outer: Element) {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
}

// A centered composer on a 400x869 phone, the same at 400x700, and the reported screen where
// the composer leaves about 316px above it and less below, so the popup opens upward.
for (const [height, triggerTop] of [
  [869, 420],
  [700, 330],
  [650, 325],
] as const) {
  it(`shows every effort level without scrolling at 400x${height}`, async () => {
    await using picker = await openPicker(height, triggerTop);
    const { popup, viewport, column, list } = picker;
    const levelList = column.querySelector<HTMLElement>("[role=radiogroup]")!.parentElement!;

    await expect
      .poll(() => {
        const rect = popup.getBoundingClientRect();
        return rect.top >= 0 && rect.bottom <= window.innerHeight;
      })
      .toBe(true);
    await expect.poll(() => viewport.scrollHeight - viewport.clientHeight).toBeLessThanOrEqual(1);
    await expect.poll(() => levelList.scrollHeight - levelList.clientHeight).toBeLessThanOrEqual(1);
    const rows = Array.from(column.querySelectorAll<HTMLElement>("[data-effort-level]"));
    expect(rows.map((row) => row.textContent)).toEqual(
      expect.arrayContaining(["Low", "MediumDefault", "High", "Xhigh", "Max"]),
    );
    for (const row of rows) {
      expect(isInside(row, levelList) && isInside(row, popup)).toBe(true);
      expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(36);
    }

    const search = list.querySelector("input")!;
    expect(isInside(search, popup)).toBe(true);
    // The list keeps its search row and still scrolls to every model.
    await page.getByPlaceholder("Search models...").fill("Model 8");
    const last = page.getByRole("option", { name: /Model 8/ });
    await expect.element(last).toBeVisible();
    await expect
      .poll(() => isInside(last.element(), list) && isInside(last.element(), popup))
      .toBe(true);
    await last.click();
    await expect.element(page.getByRole("radio", { name: "Max" })).toBeInTheDocument();

    await page.getByRole("radio", { name: "Max" }).click();
    await expect
      .element(page.getByRole("radio", { name: "Max" }))
      .toHaveAttribute("aria-checked", "true");
  });
}

it("leaves a usable model list when the phone has room", async () => {
  await using picker = await openPicker(869, 420);
  const scroller = picker.list.querySelector<HTMLElement>("[role=listbox]")!;
  expect(picker.list.getBoundingClientRect().height).toBeGreaterThanOrEqual(120);
  await expect.element(page.getByRole("option", { name: /Model 1/ })).toBeVisible();
  expect(scroller.getBoundingClientRect().height).toBeGreaterThan(0);
});
