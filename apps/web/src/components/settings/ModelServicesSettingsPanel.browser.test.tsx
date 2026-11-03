import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";
import "~/index.css";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  manage: true,
  save: vi.fn(),
  discover: vi.fn(),
  listeners: new Set<() => void>(),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  const { useSyncExternalStore } = await import("react");
  return {
    ...actual,
    useEnvironmentSettings: ((_id: string, selector?: (value: UnifiedSettings) => unknown) => {
      const value = useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => state.settings,
      );
      return selector ? selector(value) : value;
    }) as never,
  };
});
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => state.manage) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      updateSettings: state.save as never,
      discoverModelService: state.discover as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  Link: (({ children }: { children: ReactNode }) => (
    <a href="/settings/model-services">{children}</a>
  )) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsSection: (({
    title,
    headerAction,
    children,
  }: {
    title: ReactNode;
    headerAction?: ReactNode;
    children: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
      {children}
    </div>
  )) as never,
}));

import { EnvironmentModelServices } from "./ModelServicesSettingsPanel";
import { ModelServiceBindingSection } from "./ModelServiceBindingSection";

const environmentId = EnvironmentId.make("local-model-services");
const id = ModelServiceId.make("shared");
const decodeService = Schema.decodeSync(ModelServiceConfig);
const configured = decodeService({
  name: "Shared API",
  baseUrl: "https://models.test/v1",
  apiKey: "••••••",
  protocols: ["openai-chat"],
  models: [{ id: "Vendor/Exact", name: "Exact model", capabilities: { contextWindow: 64000 } }],
});
const notify = () => {
  for (const listener of state.listeners) listener();
};

function setup(services: UnifiedSettings["modelServices"] = {}) {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, modelServices: services };
  state.manage = true;
  state.save
    .mockReset()
    .mockImplementation(async ({ input }: { input: { patch: ServerSettingsPatch } }) => {
      const services = { ...state.settings.modelServices };
      for (const [key, entry] of Object.entries(input.patch.modelServices ?? {})) {
        if (entry === null) delete services[key as ModelServiceId];
        else
          services[key as ModelServiceId] = {
            ...entry,
            apiKey: entry.apiKey ? "••••••" : "",
            revision: entry.revision + 1,
          };
      }
      state.settings = { ...state.settings, modelServices: services };
      notify();
      return { _tag: "Success", value: undefined };
    });
  state.discover
    .mockReset()
    .mockImplementation(async ({ input }: { input: { serviceId: ModelServiceId } }) => {
      const service = state.settings.modelServices[input.serviceId]!;
      state.settings = {
        ...state.settings,
        modelServices: {
          ...state.settings.modelServices,
          [input.serviceId]: {
            ...service,
            models: [
              {
                id: "New/Model",
                name: "Discovered model",
                capabilities: null,
                source: "discovered",
              },
            ],
          },
        },
      };
      notify();
      return { _tag: "Success", value: undefined };
    });
}

describe("model services settings", () => {
  it("fills metadata for existing models without saving or rediscovering the connection", async () => {
    setup({ [id]: { ...configured, models: [{ id: "gpt-5", capabilities: null }] } });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await expect.element(screen.getByText("GPT-5", { exact: true })).toBeVisible();
    await screen
      .getByRole("button", { name: "Fill metadata from models.dev", exact: true })
      .click();
    expect(state.save).not.toHaveBeenCalled();
    expect(state.discover).toHaveBeenCalledWith({
      environmentId,
      input: { serviceId: id, metadataOnly: true },
    });
  });
  it("saves one centralized connection before fetching its models for the selected environment", async () => {
    setup();
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Add model service", exact: true }).click();
    await screen.getByLabelText("Service name", { exact: true }).fill("New API");
    await screen.getByLabelText("API URL", { exact: true }).fill("https://models.test/v1");
    await screen.getByLabelText("API key", { exact: true }).fill("replacement-test-key");
    await screen.getByText("Additional request headers", { exact: true }).click();
    await screen
      .getByLabelText("Request headers JSON", { exact: true })
      .fill('{"x-private":"private-header-value"}');
    await screen.getByRole("button", { name: "Save and fetch models", exact: true }).click();
    expect(state.save).toHaveBeenCalledOnce();
    const saved = state.save.mock.calls[0]![0];
    expect(saved.environmentId).toBe(environmentId);
    const entries = Object.entries(saved.input.patch.modelServices) as Array<
      [string, ModelServiceConfig]
    >;
    expect(entries[0]![1]).toMatchObject({
      name: "New API",
      baseUrl: "https://models.test/v1",
      apiKey: "replacement-test-key",
      protocols: ["openai-chat"],
    });
    expect(state.discover).toHaveBeenCalledWith({
      environmentId,
      input: { serviceId: entries[0]![0] },
    });
    await expect.element(screen.getByText("Discovered model", { exact: true })).toBeVisible();
    await expect.element(screen.getByLabelText("API key", { exact: true })).toHaveValue("");
    expect(
      (
        screen
          .getByLabelText("Request headers JSON", { exact: true })
          .element() as HTMLTextAreaElement
      ).value,
    ).not.toContain("private-header-value");
    expect(screen.container.textContent).not.toContain("replacement-test-key");
  });

  it("adds model metadata without guessing unknown capabilities or losing a stored secret", async () => {
    setup({ [id]: { ...configured, models: [] } });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Add model", exact: true }).click();
    await screen.getByLabelText("Model ID", { exact: true }).fill("Vendor/Case");
    await screen.getByLabelText("Context window", { exact: true }).fill("96000");
    await screen.getByRole("button", { name: "Save model", exact: true }).click();
    const next = state.save.mock.calls[0]![0].input.patch.modelServices[id];
    expect(next.apiKey).toBe("••••••");
    expect(next.models[0]).toMatchObject({
      id: "Vendor/Case",
      capabilities: { contextWindow: 96000 },
      source: "manual",
    });
    expect(next.models[0].capabilities.supportsImages).toBeUndefined();
    expect(next.models[0].supportsTools).toBeUndefined();
    await expect.element(screen.getByText("Vendor/Case", { exact: true }).first()).toBeVisible();
  });

  it("keeps the previous catalog after discovery failure and permits retry", async () => {
    setup({ [id]: configured });
    state.discover.mockRejectedValueOnce(new Error("test failure"));
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Save and fetch models", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The model service operation failed.");
    await expect.element(screen.getByText("Exact model", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Save and fetch models", exact: true }).click();
    expect(state.discover).toHaveBeenCalledTimes(2);
    await expect.element(screen.getByText("Discovered model", { exact: true })).toBeVisible();
  });

  it("requires unbinding before removal and enforces read-only provider access", async () => {
    setup({ [id]: configured });
    state.settings = {
      ...state.settings,
      providerInstances: {
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          modelService: { serviceId: id, modelIds: [] },
        },
      },
    };
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await expect
      .element(screen.getByRole("button", { name: "Remove service", exact: true }))
      .toBeDisabled();
    state.manage = false;
    await screen.rerender(<EnvironmentModelServices environmentId={environmentId} />);
    await expect
      .element(screen.getByRole("button", { name: "Save service", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("API URL", { exact: true })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe("agent model service binding", () => {
  it("binds a Codex instance and restores its preserved independent configuration when unbound", async () => {
    setup({ [id]: configured });
    const update = vi.fn();
    const instance: ProviderInstanceConfig = {
      driver: ProviderDriverKind.make("codex"),
      config: { binaryPath: "custom-codex", baseUrl: "https://independent.test/v1" },
    };
    await using screen = await render(
      <ModelServiceBindingSection
        environmentId={environmentId}
        instance={instance}
        readOnly={false}
        onUpdate={update}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Connection", exact: true });
    await act(async () => {
      const element = select.element() as HTMLSelectElement;
      element.value = id;
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await screen.getByRole("checkbox", { name: "Use all compatible models", exact: true }).click();
    await expect.element(screen.getByText("Protocol conversion", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Apply model service", exact: true }).click();
    const bound = update.mock.calls[0]![0] as ProviderInstanceConfig;
    expect(bound.modelService).toEqual({
      serviceId: id,
      modelIds: ["Vendor/Exact"],
      defaultModel: "Vendor/Exact",
    });
    expect(bound.config).toEqual(instance.config);
    await screen.rerender(
      <ModelServiceBindingSection
        environmentId={environmentId}
        instance={bound}
        readOnly={false}
        onUpdate={update}
      />,
    );
    await act(async () => {
      const element = select.element() as HTMLSelectElement;
      element.value = "";
      element.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await screen.getByRole("button", { name: "Apply model service", exact: true }).click();
    expect(update.mock.calls[1]![0]).toEqual(instance);
  });

  it("does not offer centralized binding to a closed agent backend", async () => {
    setup({ [id]: configured });
    await using screen = await render(
      <ModelServiceBindingSection
        environmentId={environmentId}
        instance={{ driver: ProviderDriverKind.make("cursor") }}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Apply model service", exact: true }))
      .not.toBeInTheDocument();
  });
});
