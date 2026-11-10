import {
  ProviderDriverKind,
  ProviderInstanceId,
  ModelServiceId,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { modelServiceAgentCapabilities } from "@t3tools/shared/modelServices";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import { runtimeModeConfig } from "./runtimeModeConfig";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { DockedPickerContext, ProviderModelPicker } from "./ProviderModelPicker";

it.each([
  { kind: "codex", width: 320 },
  { kind: "claudeAgent", width: 320 },
  { kind: "codex", width: 1024 },
  { kind: "claudeAgent", width: 1024 },
  { kind: "claudeAgent", width: 320, withoutXhigh: true },
  { kind: "claudeAgent", width: 1024, withoutXhigh: true },
])(
  "offers native Codex Ultra or independent Claude Ultracode and retains Fast routing for $kind at $width px (no xhigh: $withoutXhigh)",
  async ({ kind, width, withoutXhigh }) => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await using _viewport = {
      async [Symbol.asyncDispose]() {
        await page.viewport(viewport.width, viewport.height);
      },
    };
    await page.viewport(width, 812);
    const instanceId = ProviderInstanceId.make(`${kind}-service`);
    const driver = ProviderDriverKind.make(kind);
    const effortId = kind === "codex" ? "reasoningEffort" : "effort";
    const mode = kind === "codex" ? "ultra" : "high";
    const modeLabel = kind === "codex" ? "Ultra" : "Ultracode";
    const models = [
      {
        slug: "gpt-6.1-sol",
        name: "Service model",
        isCustom: true,
        capabilities:
          modelServiceAgentCapabilities(kind, {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select" as const,
                options: [
                  { id: "low", label: "Low" },
                  { id: "medium", label: "Medium" },
                  { id: "high", label: "High", isDefault: true },
                  ...(!withoutXhigh ? [{ id: "xhigh", label: "Extra High" }] : []),
                  { id: "max", label: "Max" },
                ],
              },
              {
                id: "serviceTier",
                label: "Service Tier",
                type: "select" as const,
                options: [
                  { id: "default", label: "Standard", isDefault: true },
                  { id: "priority", label: "Fast" },
                ],
              },
            ],
          }) ?? null,
      },
    ];
    const entries = deriveProviderInstanceEntries([
      {
        instanceId,
        driver,
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-01-01T00:00:00Z",
        models,
        skills: [],
        slashCommands: [],
      },
    ]);
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [instanceId]: {
          driver,
          modelService: { serviceId: ModelServiceId.make("service"), modelIds: [] },
        },
      },
    };
    const options = getAppModelOptionsForInstance(settings, entries[0]!);
    function Picker() {
      const [modelOptions, setModelOptions] = useState<
        ReadonlyArray<ProviderOptionSelection> | undefined
      >();
      const traits = {
        provider: driver,
        instanceId,
        models,
        model: "gpt-6.1-sol",
        modelOptions,
        planModeEnabled: false,
        onModelOptionsChange: setModelOptions,
      };
      const display = describeComposerEffort(traits, "bars", "sm");
      return (
        <>
          <output aria-label="Selected service tier">
            {modelOptions?.find((option) => option.id === "serviceTier")?.value ?? "default"}
          </output>
          <output aria-label="Selected effort">
            {modelOptions?.find((option) => option.id === effortId)?.value ?? "high"}
          </output>
          <output aria-label="Workflow enabled">
            {String(modelOptions?.find((option) => option.id === "ultracode")?.value ?? false)}
          </output>
          <ProviderModelPicker
            environmentId={null}
            activeInstanceId={instanceId}
            model="gpt-6.1-sol"
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={new Map([[instanceId, options]])}
            triggerAriaLabel="Choose model"
            triggerSuffix={display.suffix}
            triggerDetail={display.detail}
            onInstanceModelChange={() => {}}
            effortColumn={<ComposerEffortColumn traits={traits} />}
            footer={
              <DockedPickerContext
                value={{ modelLabel: "Service model", layout: width === 320 ? "sheet" : "popover" }}
              >
                <ComposerPickerFooter
                  traits={traits}
                  runtimeMode="full-access"
                  runtimeModeOptions={[
                    { mode: "full-access", ...runtimeModeConfig["full-access"] },
                  ]}
                  onRuntimeModeChange={() => {}}
                />
              </DockedPickerContext>
            }
          />
        </>
      );
    }
    await using screen = await render(<Picker />);
    await screen.getByRole("button", { name: /^Choose model/ }).click();
    await expect.element(page.getByRole("option", { name: /Service model/ })).toBeVisible();
    if (withoutXhigh)
      await expect
        .element(page.getByRole("radio", { name: "Extra High", exact: true }))
        .not.toBeInTheDocument();
    const modeControl = () =>
      page.getByRole(kind === "codex" ? "radio" : "button", {
        name: modeLabel,
        exact: true,
      });
    await modeControl().click();
    await expect
      .element(screen.getByRole("status", { name: "Selected effort" }))
      .toHaveTextContent(mode);
    await expect
      .element(modeControl())
      .toHaveAttribute(kind === "codex" ? "aria-checked" : "aria-pressed", "true");
    if (kind === "claudeAgent" && width === 320) {
      await expect.element(modeControl()).toHaveClass("data-checked:bg-popover");
    }
    if (kind === "claudeAgent") {
      await expect
        .element(screen.getByRole("status", { name: "Workflow enabled" }))
        .toHaveTextContent("true");
      await page.getByRole("radio", { name: "Low", exact: true }).click();
      await expect
        .element(screen.getByRole("status", { name: "Selected effort" }))
        .toHaveTextContent("low");
      await expect.element(modeControl()).toHaveAttribute("aria-pressed", "true");
      await modeControl().click();
      await expect
        .element(screen.getByRole("status", { name: "Selected effort" }))
        .toHaveTextContent("low");
      await modeControl().click();
    }
    await page.getByRole("radio", { name: "Fast", exact: true }).click();
    await expect
      .element(screen.getByRole("status", { name: "Selected service tier" }))
      .toHaveTextContent("priority");
    await expect
      .element(page.getByRole("radio", { name: "Fast", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
    await expect
      .element(
        screen.getByRole("button", { name: /^Choose model/ }).getByText(modeLabel, { exact: true }),
      )
      .toBeVisible();
    await screen.getByRole("button", { name: /^Choose model/ }).click();
    await expect
      .element(modeControl())
      .toHaveAttribute(kind === "codex" ? "aria-checked" : "aria-pressed", "true");
    if (kind === "claudeAgent" && width === 320) {
      await expect.element(modeControl()).toHaveClass("data-checked:bg-popover");
    }
    await expect
      .element(page.getByRole("radio", { name: "Fast", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{Escape}");
  },
);

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});
