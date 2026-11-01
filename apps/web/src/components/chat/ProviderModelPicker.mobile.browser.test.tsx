import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

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
const fastMode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
  id: "fastMode",
  label: "Fast mode",
  type: "boolean",
  currentValue: false,
};
const models: ReadonlyArray<ServerProviderModel> = Array.from({ length: 8 }, (_, index) => ({
  slug: `model-${index + 1}`,
  name: `Model ${index + 1}`,
  isCustom: false,
  capabilities: { optionDescriptors: [levels, fastMode] },
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

/** Reports a touch screen to `(pointer: coarse)` queries, as a phone's WebView does. */
function coarsePointer() {
  const matchMedia = window.matchMedia;
  const spy = vi
    .spyOn(window, "matchMedia")
    .mockImplementation((query) =>
      matchMedia.call(
        window,
        query
          .replaceAll("(pointer: coarse)", "(min-width: 0px)")
          .replaceAll("(pointer: fine)", "(max-width: 0px)"),
      ),
    );
  return { [Symbol.dispose]: () => spy.mockRestore() };
}

async function openSheet(height: number, triggerTop: number) {
  const stack = new AsyncDisposableStack();
  stack.use(coarsePointer());
  stack.use(await phoneViewport(400, height));
  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:8px;top:${triggerTop}px`;
  stack.use(await render(<Picker />, { container }));
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("radio", { name: "Max" })).toBeInTheDocument();
  const sheet = document.querySelector<HTMLElement>("[data-model-picker-sheet]")!;
  await expect.poll(() => sheet.getAnimations({ subtree: true }).length).toBe(0);
  return {
    sheet,
    effort: sheet.querySelector<HTMLElement>("[data-model-picker-effort]")!,
    list: sheet.querySelector<HTMLElement>("[role=listbox]")!,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

function isInside(inner: Element, outer: Element) {
  const a = inner.getBoundingClientRect();
  const b = outer.getBoundingClientRect();
  return (
    a.top >= b.top - 0.5 &&
    a.bottom <= b.bottom + 0.5 &&
    a.left >= b.left - 0.5 &&
    a.right <= b.right + 0.5
  );
}

function visibleRows(list: HTMLElement) {
  return Array.from(list.querySelectorAll<HTMLElement>("[role=option]")).filter((row) =>
    isInside(row, list),
  );
}

// A composer in the middle of a 400x869 phone, the same composer at the bottom of a thread,
// and a short 400x650 screen. The sheet ignores where the trigger is.
for (const [height, triggerTop] of [
  [869, 420],
  [869, 800],
  [650, 325],
] as const) {
  it(`docks the picker to the bottom edge at 400x${height} (trigger at ${triggerTop})`, async () => {
    await using picker = await openSheet(height, triggerTop);
    const { sheet, effort, list } = picker;

    const rect = sheet.getBoundingClientRect();
    expect(rect.left).toBe(0);
    expect(rect.width).toBe(400);
    expect(Math.abs(rect.bottom - window.innerHeight)).toBeLessThanOrEqual(1);
    expect(rect.top).toBeGreaterThanOrEqual(height * 0.15 - 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(400);
    expect(sheet.scrollHeight - sheet.clientHeight).toBeLessThanOrEqual(1);

    // Every level and the speed and access controls show without scrolling.
    const levels = Array.from(effort.querySelectorAll<HTMLElement>("[data-effort-level]"));
    expect(levels.map((level) => level.textContent)).toEqual([
      "Low",
      "Medium",
      "High",
      "Xhigh",
      "Max",
    ]);
    for (const level of levels) {
      expect(isInside(level, sheet)).toBe(true);
      expect(level.getBoundingClientRect().height).toBeGreaterThanOrEqual(40);
    }
    const track = levels[0]!.parentElement!;
    expect(track.scrollWidth - track.clientWidth).toBeLessThanOrEqual(1);
    expect(isInside(page.getByRole("radio", { name: "Fast" }).element(), sheet)).toBe(true);
    expect(isInside(page.getByRole("button", { name: /^Permissions/ }).element(), sheet)).toBe(
      true,
    );
    expect(
      levels.find((level) => level.dataset.effortDefault)?.getAttribute("aria-description"),
    ).toBe("Default");

    // Rows are thumb-sized, and the list scrolls to every model.
    const rows = visibleRows(list);
    expect(rows.length).toBeGreaterThanOrEqual(height >= 869 ? 4 : 2);
    for (const row of rows) expect(row.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    await page.getByPlaceholder("Search models...").fill("Model 8");
    const last = page.getByRole("option", { name: /Model 8/ });
    await expect.poll(() => isInside(last.element(), list)).toBe(true);
    await last.click();
    await expect.element(page.getByPlaceholder("Search models...")).not.toHaveFocus();
    await expect
      .element(page.getByRole("dialog").getByText("Model 8", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("option", { name: /Model 8/ }))
      .toHaveAttribute("aria-selected", "true");

    await page.getByRole("radio", { name: "Max" }).click();
    await expect
      .element(page.getByRole("radio", { name: "Max" }))
      .toHaveAttribute("aria-checked", "true");
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  });
}

it("shows at least four models on a 400x869 phone", async () => {
  await using picker = await openSheet(869, 420);
  expect(visibleRows(picker.list).length).toBeGreaterThanOrEqual(4);
});

it("keeps the soft keyboard closed when a touch screen opens the picker", async () => {
  await using picker = await openSheet(869, 420);
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).not.toHaveFocus();
  await expect.poll(() => picker.sheet.contains(document.activeElement)).toBe(true);

  // Provider chips switch tabs without raising the keyboard.
  await page.getByRole("button", { name: "Favorites" }).click();
  await expect.element(page.getByText("No favorites yet")).toBeInTheDocument();
  await page.getByRole("button", { name: "Codex" }).click();
  await expect.element(search).not.toHaveFocus();
  await expect.element(page.getByRole("option", { name: /Model 1/ })).toBeVisible();

  // A hardware keyboard still moves through the levels.
  await page.getByRole("radio", { name: /^Medium/ }).click();
  await userEvent.keyboard("{ArrowRight}{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "Xhigh" })).toHaveFocus();

  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("keeps the list above the keyboard while searching on a short screen", async () => {
  await using picker = await openSheet(650, 325);
  await page.getByPlaceholder("Search models...").click();
  // A soft keyboard leaves about 350px of a 650px screen.
  await page.viewport(400, 350);
  await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
  await expect
    .poll(() => Math.abs(picker.sheet.getBoundingClientRect().bottom - window.innerHeight))
    .toBeLessThanOrEqual(1);
  await expect.poll(() => visibleRows(picker.list).length).toBeGreaterThanOrEqual(2);
  expect(isInside(picker.list, picker.sheet)).toBe(true);
});

for (const close of ["scrim", "Done", "Escape"] as const) {
  it(`closes on ${close}`, async () => {
    await using _picker = await openSheet(869, 420);
    if (close === "scrim") {
      await userEvent.click(document.body, { position: { x: 200, y: 40 } });
    } else if (close === "Done") {
      await page.getByRole("button", { name: "Done" }).click();
    } else {
      await userEvent.keyboard("{Escape}");
    }
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Choose model" })).toBeInTheDocument();
  });
}

it("still puts a fine pointer straight into the search of a popover", async () => {
  await using _viewport = await phoneViewport(1280, 900);
  await using _screen = await render(<Picker />);
  await page.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  expect(document.querySelector("[data-model-picker-sheet]")).toBeNull();
  expect(document.querySelector("[data-slot=popover-popup]")).not.toBeNull();
  await userEvent.keyboard("Model 8");
  await expect.element(page.getByRole("option", { name: /Model 8/ })).toBeVisible();
  await expect.element(page.getByRole("option", { name: /Model 1 / })).not.toBeInTheDocument();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

/** The picker on the app's own kind of router: browser history and a root loader to count. */
async function openOnBrowserRouter() {
  const stack = new AsyncDisposableStack();
  stack.use(coarsePointer());
  stack.use(await phoneViewport(400, 869));
  const startUrl = window.location.href;
  // Drops forward entries an earlier test left, so history.length counts what is behind us.
  window.history.pushState(null, "", startUrl);
  const history = createBrowserHistory();
  stack.defer(() => history.destroy());
  let loads = 0;
  const router = createRouter({
    routeTree: createRootRoute({
      loader: () => {
        loads += 1;
      },
      component: Picker,
    }),
    history,
  });
  await router.load();
  const container = document.createElement("div");
  container.style.cssText = "position:fixed;left:8px;top:420px";
  stack.use(await render(<RouterProvider router={router} />, { container, router: false }));
  await expect.element(page.getByRole("button", { name: "Choose model" })).toBeInTheDocument();
  const settled = {
    length: window.history.length,
    loads,
    routerKey: window.history.state?.__TSR_key as string,
  };
  const open = async () => {
    await page.getByRole("button", { name: "Choose model" }).click();
    await expect.element(page.getByRole("dialog")).toBeInTheDocument();
    await expect.poll(() => window.history.length).toBe(settled.length + 1);
  };
  const closed = async () => {
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await expect.poll(() => window.history.state?.coxBackDismiss).toBeUndefined();
    expect(window.location.href).toBe(startUrl);
    expect(window.history.state?.__TSR_key).toBe(settled.routerKey);
    expect(router.state.location.href).toBe(router.latestLocation.href);
    expect(loads).toBe(settled.loads);
  };
  return { open, closed, settled, router, [Symbol.asyncDispose]: () => stack.disposeAsync() };
}

it("closes the sheet on Back without leaving the route", async () => {
  await using app = await openOnBrowserRouter();
  const route = app.router.state.location.href;
  await app.open();
  expect(window.history.state?.coxBackDismiss).toBeTruthy();
  window.history.back();
  await app.closed();
  expect(app.router.state.location.href).toBe(route);
  // The entry is gone, so the next Back would leave the page as before.
  await app.open();
  await page.getByRole("button", { name: "Done" }).click();
  await app.closed();
});

it("pops its history entry once however the sheet closes", async () => {
  await using app = await openOnBrowserRouter();
  const closers = [
    () => page.getByRole("button", { name: "Done" }).click(),
    () => userEvent.keyboard("{Escape}"),
    () => userEvent.click(document.body, { position: { x: 200, y: 40 } }),
    () => window.history.back(),
  ];
  for (let cycle = 0; cycle < 3; cycle++) {
    for (const close of closers) {
      await app.open();
      await close();
      await app.closed();
    }
  }
  // Each open replaced the one forward entry the previous close left, so nothing piled up.
  expect(window.history.length).toBe(app.settled.length + 1);
});

it("keeps history straight through a rapid close and reopen", async () => {
  await using app = await openOnBrowserRouter();
  await app.open();
  await page.getByRole("button", { name: "Done" }).click();
  // Reopen before our own Back has landed.
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("dialog")).toBeInTheDocument();
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");
  window.history.back();
  await app.closed();
});

it("removes its history entry when the sheet unmounts while open", async () => {
  await using app = await openOnBrowserRouter();
  await app.open();
  await app[Symbol.asyncDispose]();
  await expect.poll(() => window.history.state?.coxBackDismiss).toBeUndefined();
  expect(window.history.state?.__TSR_key).toBe(app.settled.routerKey);
  expect(window.history.length).toBe(app.settled.length + 1);
});

it("leaves history alone for the desktop popover", async () => {
  await using _viewport = await phoneViewport(1280, 900);
  await using _screen = await render(<Picker />);
  const length = window.history.length;
  await page.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByPlaceholder("Search models...")).toHaveFocus();
  expect(window.history.length).toBe(length);
  expect(window.history.state?.coxBackDismiss).toBeUndefined();
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByPlaceholder("Search models...")).not.toBeInTheDocument();
  expect(window.history.length).toBe(length);
});
