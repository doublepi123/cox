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
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import "~/index.css";
import { LANGUAGE_STORAGE_KEY, setLanguagePreference } from "../../i18n";
import { parseLanguagePreference } from "../../i18n/language";

const state = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  manage: true,
  save: vi.fn(),
  discover: vi.fn(),
  testModel: vi.fn(),
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
      testModelService: state.testModel as never,
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
  state.testModel
    .mockReset()
    .mockImplementation(async ({ input }: { input: { modelId: string; revision: number } }) => ({
      _tag: "Success",
      value: {
        modelId: input.modelId,
        revision: input.revision,
        ok: !input.modelId.includes("bad"),
        protocol: "openai-chat",
        durationMs: 10,
        message: input.modelId.includes("bad") ? "Model test failed (HTTP 404)." : null,
      },
    }));
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

async function openModelActions(
  screen: Awaited<ReturnType<typeof render>>,
  model: string,
  language: "en" | "zh" = "en",
) {
  await screen
    .getByRole("button", {
      name: language === "zh" ? `模型 ${model} 的更多操作` : `Model actions for ${model}`,
      exact: true,
    })
    .click();
}

async function requestModelDeletion(
  screen: Awaited<ReturnType<typeof render>>,
  model = "Exact model",
  language: "en" | "zh" = "en",
) {
  await openModelActions(screen, model, language);
  await page
    .getByRole("menuitem", {
      name: language === "zh" ? `删除模型 ${model}` : `Delete model ${model}`,
      exact: true,
    })
    .click();
}

describe("model services settings", () => {
  it("ignores one model without testing or removing it and can restore its full configuration", async () => {
    const otherService = ModelServiceId.make("other");
    const keep = { id: "Vendor/Keep", name: "Keep model", capabilities: null };
    setup({
      [id]: { ...configured, models: [...configured.models, keep] },
      [otherService]: { ...configured, name: "Other service" },
    });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    const ignore = screen.getByRole("button", { name: "Ignore model Exact model", exact: true });
    await expect.element(ignore).toHaveTextContent("Ignore model");
    expect(ignore.element().parentElement?.querySelectorAll("button")).toHaveLength(2);
    await ignore.click();
    await expect
      .element(screen.getByRole("button", { name: "Restore model Exact model", exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("Ignored", { exact: true })).toBeVisible();
    expect(state.settings.modelServices[id]?.models).toEqual([
      { ...configured.models[0]!, ignored: true },
      keep,
    ]);
    expect(state.settings.modelServices[otherService]).toEqual({
      ...configured,
      name: "Other service",
    });
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.discover).not.toHaveBeenCalled();
    expect(state.testModel).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Test all models", exact: true }).click();
    expect(state.testModel).toHaveBeenCalledOnce();
    expect(state.testModel.mock.calls[0]![0].input.modelId).toBe(keep.id);
    await screen.getByRole("button", { name: "Restore model Exact model", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Ignore model Exact model", exact: true }))
      .toBeVisible();
    expect(state.settings.modelServices[id]?.models).toEqual([
      { ...configured.models[0]!, ignored: false },
      keep,
    ]);
  });

  it("retains a model's previous state when ignoring fails and allows retry", async () => {
    setup({ [id]: configured });
    state.save.mockRejectedValueOnce(new Error("controlled ignore failure"));
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Ignore model Exact model", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The model service operation failed.");
    expect(state.settings.modelServices[id]?.models).toEqual(configured.models);
    await screen.getByRole("button", { name: "Ignore model Exact model", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Restore model Exact model", exact: true }))
      .toBeVisible();
    expect(state.settings.modelServices[id]?.models[0]?.ignored).toBe(true);
  });

  it("confirms model removal with cancel focused and keeps cancellation side-effect free", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await requestModelDeletion(screen);
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Cancel", exact: true })).toHaveFocus();
    await expect.element(page.getByText(/Refreshing models may add it again/)).toBeVisible();
    expect(state.save).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(state.settings.modelServices[id]?.models).toEqual(configured.models);
    expect(state.save).not.toHaveBeenCalled();
  });

  it.each(["manual", "discovered"] as const)(
    "deletes a %s model without changing the service or other models",
    async (source) => {
      const otherService = ModelServiceId.make("other");
      const removed = { ...configured.models[0]!, source };
      const retained = {
        id: "Vendor/Keep",
        name: "Keep model",
        capabilities: { contextWindow: 32000 },
      };
      setup({
        [id]: { ...configured, models: [removed, retained] },
        [otherService]: { ...configured, name: "Other service" },
      });
      state.settings = {
        ...state.settings,
        providerInstances: {
          [ProviderInstanceId.make("work")]: {
            driver: ProviderDriverKind.make("codex"),
            modelService: { serviceId: id, modelIds: [], defaultModel: retained.id },
          },
        },
      };
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      await requestModelDeletion(screen);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      await expect
        .element(screen.getByText("Exact model", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(screen.getByText("Keep model", { exact: true })).toBeVisible();
      expect(state.save).toHaveBeenCalledOnce();
      expect(state.save.mock.calls[0]![0]).toEqual({
        environmentId,
        input: { patch: { modelServices: { [id]: { ...configured, models: [retained] } } } },
      });
      expect(state.settings.modelServices[otherService]).toEqual({
        ...configured,
        name: "Other service",
      });
      expect(
        state.settings.providerInstances[ProviderInstanceId.make("work")]?.modelService
          ?.defaultModel,
      ).toBe(retained.id);
      expect(state.discover).not.toHaveBeenCalled();
      expect(state.testModel).not.toHaveBeenCalled();
    },
  );

  it("allows removing the last model from an unbound service", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await requestModelDeletion(screen);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(state.settings.modelServices[id]?.models).toEqual([]);
    await expect
      .element(screen.getByText("Fetch models or add them manually before binding an agent."))
      .toBeVisible();
  });

  it.each([
    { modelIds: ["Vendor/Exact", "Vendor/Keep"] },
    { modelIds: [], defaultModel: "Vendor/Exact" },
  ])("blocks removal while a model is explicitly bound: %j", async (binding) => {
    setup({
      [id]: {
        ...configured,
        models: [...configured.models, { id: "Vendor/Keep", capabilities: null }],
      },
    });
    state.settings = {
      ...state.settings,
      providerInstances: {
        [ProviderInstanceId.make("work")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          displayName: "Work Claude",
          modelService: { serviceId: id, ...binding },
        },
      },
    };
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await requestModelDeletion(screen);
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent(
        "This model is selected or required by these agents: Work Claude. Change their model bindings before deleting it.",
      );
    await expect.element(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("rechecks bindings and access while the deletion confirmation is open", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await requestModelDeletion(screen);
    await act(() => {
      state.settings = {
        ...state.settings,
        providerInstances: {
          [ProviderInstanceId.make("work")]: {
            driver: ProviderDriverKind.make("pi"),
            modelService: { serviceId: id, modelIds: [] },
          },
        },
      };
      notify();
    });
    await expect.element(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await act(() => {
      state.settings = { ...state.settings, providerInstances: {} };
      notify();
    });
    await expect.element(page.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
    state.manage = false;
    await screen.rerender(<EnvironmentModelServices environmentId={environmentId} />);
    await expect.element(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    expect(state.save).not.toHaveBeenCalled();
  });

  it("keeps the model and confirmation after a failed save and permits retry", async () => {
    setup({ [id]: configured });
    state.save.mockRejectedValueOnce(new Error("controlled deletion failure"));
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await requestModelDeletion(screen);
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The model service operation failed.");
    expect(state.settings.modelServices[id]?.models).toEqual(configured.models);
    await expect.element(screen.getByText("Exact model", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(state.settings.modelServices[id]?.models).toEqual([]);
  });

  it("uses one save action and only fetches models when the connection changes", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await expect
      .element(screen.getByRole("button", { name: "Save changes", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Save and fetch models", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Refresh models", exact: true }))
      .toBeEnabled();
    await screen.getByLabelText("Service name", { exact: true }).fill("Renamed API");
    await screen.getByRole("button", { name: "Save changes", exact: true }).click();
    expect(state.save).toHaveBeenCalledOnce();
    expect(state.discover).not.toHaveBeenCalled();
    await screen.getByLabelText("API key", { exact: true }).fill("replacement-key");
    await expect
      .element(screen.getByRole("button", { name: "Save and fetch models", exact: true }))
      .toBeVisible();
    await screen.getByRole("button", { name: "Save and fetch models", exact: true }).click();
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(state.discover).toHaveBeenCalledOnce();
  });

  it("shows the selected service clearly and switches editors from the service picker", async () => {
    const backupId = ModelServiceId.make("backup");
    setup({
      [id]: configured,
      [backupId]: {
        ...configured,
        name: "Backup API",
        baseUrl: "https://backup.test/v1",
        models: [],
      },
    });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await expect
      .element(screen.getByRole("group", { name: "Configured model services" }))
      .toBeVisible();
    const primary = screen.getByRole("button", { name: /Shared API/ });
    const backup = screen.getByRole("button", { name: /Backup API/ });
    await expect.element(primary).toHaveAttribute("aria-pressed", "true");
    await expect.element(backup).toHaveAttribute("aria-pressed", "false");
    expect(primary.element().textContent).toContain("1 model");
    expect(backup.element().textContent).toContain("0 models");
    await backup.click();
    await expect.element(backup).toHaveAttribute("aria-pressed", "true");
    await expect.element(primary).toHaveAttribute("aria-pressed", "false");
    await expect
      .element(screen.getByLabelText("API URL", { exact: true }))
      .toHaveValue("https://backup.test/v1");
  });

  it("tests the current models, ignores failures without deleting them and allows restoring one", async () => {
    setup({
      [id]: {
        ...configured,
        models: [
          { id: "good", capabilities: null },
          { id: "bad", capabilities: null },
        ],
      },
    });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Test all models", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Ignore failed models (1)" }))
      .toBeEnabled();
    expect(state.testModel).toHaveBeenCalledTimes(2);
    await screen.getByRole("button", { name: "Ignore failed models (1)" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Restore model bad", exact: true }))
      .toBeVisible();
    expect(state.settings.modelServices[id]?.models).toMatchObject([
      { id: "good" },
      { id: "bad", ignored: true },
    ]);
    await screen.getByRole("button", { name: "Restore model bad", exact: true }).click();
    expect(
      state.settings.modelServices[id]?.models.find((model) => model.id === "bad")?.ignored,
    ).toBe(false);
  });

  it("does not offer tests with unsaved credentials or without management permission", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByLabelText("API key", { exact: true }).fill("unsaved-key");
    await expect
      .element(screen.getByRole("button", { name: "Test all models", exact: true }))
      .toBeDisabled();
    expect(state.testModel).not.toHaveBeenCalled();
  });
  it.each([
    ["Recovery budget (seconds)", "budgetMs", 600, "650", 650000],
    ["Response headers timeout (seconds)", "responseHeadersTimeoutMs", 300, "350", 350000],
    ["Maximum concurrent requests", "maxConcurrent", 5, "10", 10],
  ] as const)(
    "allows clearing and replacing %s without retaining zero",
    async (label, key, initial, replacement, saved) => {
      setup({ [id]: configured });
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      await screen.getByText("Recovery limits and timing", { exact: true }).click();
      const input = screen.getByLabelText(label, { exact: true });
      await expect.element(input).toHaveValue(initial);
      await input.fill("0");
      await expect.element(input).toHaveValue(0);
      await input.fill("");
      await expect.element(input).toHaveValue(null);
      await input.fill(replacement);
      await screen.getByRole("button", { name: "Save changes", exact: true }).click();
      expect(state.save.mock.calls[0]![0].input.patch.modelServices[id].recovery[key]).toBe(saved);
    },
  );

  it("saves independent recovery switches, thresholds and shared limits", async () => {
    setup({ [id]: configured });
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await expect
      .element(
        screen.getByRole("checkbox", {
          name: "Automatically retry temporary failures",
          exact: true,
        }),
      )
      .toBeChecked();
    await screen
      .getByRole("checkbox", { name: "Automatically retry temporary failures", exact: true })
      .click();
    await expect
      .element(screen.getByRole("checkbox", { name: "Respect 429 cooldown", exact: true }))
      .not.toBeInTheDocument();
    for (const name of [
      "Retry all 429 responses, including quota limits",
      "Retry non-transient upstream errors (e.g. HTTP 400)",
      "Retry failed requests with upstream tools",
    ]) {
      await expect.element(screen.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
      await screen.getByRole("checkbox", { name, exact: true }).click();
    }
    await expect
      .element(
        screen.getByRole("checkbox", {
          name: "Start backup requests when responses are slow",
          exact: true,
        }),
      )
      .toBeChecked();
    await screen.getByText("Recovery limits and timing", { exact: true }).click();
    await screen.getByLabelText("Backup delay (seconds)", { exact: true }).fill("2");
    await screen.getByLabelText("Reasoning backup delay (seconds)", { exact: true }).fill("5");
    await screen.getByLabelText("Maximum attempts (including backups)", { exact: true }).fill("7");
    await screen.getByLabelText("Recovery budget (seconds)", { exact: true }).fill("60");
    await screen.getByLabelText("Response headers timeout (seconds)", { exact: true }).fill("30");
    await screen.getByRole("button", { name: "Save changes", exact: true }).click();
    expect(state.save.mock.calls[0]![0].input.patch.modelServices[id].recovery).toEqual({
      retryEnabled: false,
      retryOn429: true,
      retryNonTransientErrors: true,
      retryToolRequests: true,
      hedgeEnabled: true,
      hedgeDelayMs: 2000,
      reasoningHedgeDelayMs: 5000,
      maxAttempts: 7,
      budgetMs: 60000,
      responseHeadersTimeoutMs: 30000,
      maxConcurrent: 5,
    });
  });
  it("localizes the non-transient retry switch and warning with live language changes", async () => {
    setup({ [id]: configured });
    const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    setLanguagePreference("zh");
    try {
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      const toggle = screen.getByRole("checkbox", {
        name: "重试非常规上游错误（如 HTTP 400）",
        exact: true,
      });
      await expect.element(toggle).not.toBeChecked();
      await toggle.click();
      await expect.element(screen.getByText(/需开启自动重试。在开始输出前/)).toBeVisible();
      await expect
        .element(screen.getByText(/Requires automatic retries\./))
        .not.toBeInTheDocument();
      await act(() => setLanguagePreference("en"));
      await expect
        .element(
          screen.getByRole("checkbox", {
            name: "Retry non-transient upstream errors (e.g. HTTP 400)",
            exact: true,
          }),
        )
        .toBeChecked();
      await expect.element(screen.getByText(/Requires automatic retries\./)).toBeVisible();
      await screen.getByRole("button", { name: "Save changes", exact: true }).click();
      expect(
        state.save.mock.calls[0]![0].input.patch.modelServices[id].recovery.retryNonTransientErrors,
      ).toBe(true);
    } finally {
      setLanguagePreference(parseLanguagePreference(originalLanguage));
      if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    }
  });
  it.each([
    { width: 320, language: "zh" as const, desktop: false },
    { width: 390, language: "en" as const, desktop: false },
    { width: 1280, language: "zh" as const, desktop: true },
  ])("fits the editor at $widthpx", async ({ width, language, desktop }) => {
    setup({ [id]: { ...configured, name: "newapi" } });
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    await page.viewport(width, 812);
    setLanguagePreference(language);
    try {
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      for (const label of language === "zh"
        ? ["服务名称", "API 地址", "API 密钥", "支持的协议"]
        : ["Service name", "API URL", "API key", "Supported protocols"]) {
        const element = screen.getByText(label, { exact: true }).element();
        expect(Number.parseFloat(getComputedStyle(element).fontSize)).toBeGreaterThanOrEqual(12);
      }
      const picker = screen.getByRole("group", {
        name: language === "zh" ? "已配置的模型服务" : "Configured model services",
      });
      expect(picker.element().scrollWidth).toBeLessThanOrEqual(picker.element().clientWidth);
      expect(
        screen
          .getByRole("button", { name: /newapi/ })
          .element()
          .getBoundingClientRect().height,
      ).toBeGreaterThanOrEqual(44);
      const fetchButton = screen
        .getByRole("button", {
          name: language === "zh" ? "保存更改" : "Save changes",
          exact: true,
        })
        .element()
        .getBoundingClientRect();
      expect(width < 640 ? fetchButton.width : fetchButton.right).toBeGreaterThan(250);
      if (desktop) {
        const name = screen.getByLabelText("服务名称", { exact: true }).element();
        const protocols = screen.getByText("支持的协议", { exact: true }).element();
        const nameBox = name.getBoundingClientRect();
        const protocolBox = protocols.getBoundingClientRect();
        expect(protocolBox.left).toBeGreaterThan(nameBox.right);
        expect(Math.abs(protocolBox.top - nameBox.top)).toBeLessThan(40);
      }
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(width);
      await screen
        .getByRole("button", {
          name: language === "zh" ? "忽略模型 Exact model" : "Ignore model Exact model",
          exact: true,
        })
        .click();
      await expect
        .element(
          screen.getByRole("button", {
            name: language === "zh" ? "恢复模型 Exact model" : "Restore model Exact model",
            exact: true,
          }),
        )
        .toBeVisible();
      await requestModelDeletion(screen, "Exact model", language);
      const confirmation = page.getByRole("alertdialog").element();
      expect(confirmation.scrollWidth).toBeLessThanOrEqual(confirmation.clientWidth);
      expect(confirmation.getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await page
        .getByRole("button", { name: language === "zh" ? "取消" : "Cancel", exact: true })
        .click();
    } finally {
      setLanguagePreference(parseLanguagePreference(originalLanguage));
      if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      await page.viewport(originalWidth, originalHeight);
    }
  });

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
    expect(next.models[0].capabilities.optionDescriptors).toBeUndefined();
    expect(next.models[0].supportsTools).toBeUndefined();
    await expect.element(screen.getByText("Vendor/Case", { exact: true }).first()).toBeVisible();
  });

  it.each([
    { width: 320, language: "zh" as const },
    { width: 390, language: "en" as const },
  ])("edits explicit service tiers for Fast routing at $widthpx", async ({ width, language }) => {
    setup({ [id]: configured });
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;
    const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    await page.viewport(width, 812);
    setLanguagePreference(language);
    try {
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      await openModelActions(screen, "Exact model", language);
      await page
        .getByRole("menuitem", { name: language === "zh" ? "编辑" : "Edit", exact: true })
        .click();
      const field = screen.getByLabelText(language === "zh" ? "服务优先级档位" : "Service tiers", {
        exact: true,
      });
      await expect.element(field).toHaveValue("");
      await field.fill("default，priority, priority");
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(width);
      await screen
        .getByRole("button", { name: language === "zh" ? "保存模型" : "Save model", exact: true })
        .click();
      const next = decodeService(state.save.mock.calls[0]![0].input.patch.modelServices[id]);
      expect(next.models[0]?.capabilities?.optionDescriptors).toEqual([
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [
            { id: "default", label: "Standard", isDefault: true },
            { id: "priority", label: "Fast" },
          ],
        },
      ]);
    } finally {
      setLanguagePreference(parseLanguagePreference(originalLanguage));
      if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      await page.viewport(originalWidth, originalHeight);
    }
  });

  it.each([
    { width: 320, language: "zh" as const },
    { width: 390, language: "en" as const },
  ])(
    "edits reasoning levels at $widthpx without losing model metadata",
    async ({ width, language }) => {
      const speed = { id: "fastMode", label: "Fast Mode", type: "boolean" as const };
      setup({
        [id]: {
          ...configured,
          models: [
            {
              ...configured.models[0]!,
              capabilities: {
                contextWindow: 64000,
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    currentValue: "high",
                    options: [
                      { id: "low", label: "Low" },
                      { id: "high", label: "High", description: "Deep thought", isDefault: true },
                    ],
                  },
                  speed,
                ],
              },
            },
          ],
        },
      });
      const originalWidth = window.innerWidth;
      const originalHeight = window.innerHeight;
      const originalLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
      await page.viewport(width, 812);
      setLanguagePreference(language);
      try {
        await using screen = await render(
          <EnvironmentModelServices environmentId={environmentId} />,
        );
        await openModelActions(screen, "Exact model", language);
        await page
          .getByRole("menuitem", { name: language === "zh" ? "编辑" : "Edit", exact: true })
          .click();
        const input = screen.getByLabelText(
          language === "zh" ? "思考强度档位" : "Reasoning levels",
          { exact: true },
        );
        await expect.element(input).toHaveValue("low, high");
        await input.fill("low，high, max, ultra, ultra");
        expect(screen.container.scrollWidth).toBeLessThanOrEqual(width);
        await screen
          .getByRole("button", { name: language === "zh" ? "保存模型" : "Save model", exact: true })
          .click();
        const next = decodeService(state.save.mock.calls[0]![0].input.patch.modelServices[id]);
        expect(next.models[0]?.source).toBe("manual");
        expect(next.models[0]?.capabilities).toEqual({
          contextWindow: 64000,
          optionDescriptors: [
            speed,
            {
              id: "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "high",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", description: "Deep thought", isDefault: true },
                { id: "max", label: "max" },
                { id: "ultra", label: "ultra" },
              ],
            },
          ],
        });
      } finally {
        setLanguagePreference(parseLanguagePreference(originalLanguage));
        if (originalLanguage === null) localStorage.removeItem(LANGUAGE_STORAGE_KEY);
        await page.viewport(originalWidth, originalHeight);
      }
    },
  );

  it.each(["ultra", ""])(
    "removes stale reasoning defaults when levels change to '%s'",
    async (levels) => {
      setup({
        [id]: {
          ...configured,
          models: [
            {
              ...configured.models[0]!,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "reasoningEffort",
                    label: "Reasoning",
                    type: "select",
                    currentValue: "high",
                    options: [{ id: "high", label: "High", isDefault: true }],
                  },
                ],
              },
            },
          ],
        },
      });
      await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
      await openModelActions(screen, "Exact model");
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      await screen.getByLabelText("Reasoning levels", { exact: true }).fill(levels);
      await screen.getByRole("button", { name: "Save model", exact: true }).click();
      const next = state.save.mock.calls[0]![0].input.patch.modelServices[id];
      expect(next.models[0].capabilities.optionDescriptors).toEqual(
        levels
          ? [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "ultra", label: "ultra" }],
              },
            ]
          : [],
      );
    },
  );

  it("keeps the previous catalog after discovery failure and permits retry", async () => {
    setup({ [id]: configured });
    state.discover.mockRejectedValueOnce(new Error("test failure"));
    await using screen = await render(<EnvironmentModelServices environmentId={environmentId} />);
    await screen.getByRole("button", { name: "Refresh models", exact: true }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The model service operation failed.");
    await expect.element(screen.getByText("Exact model", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Refresh models", exact: true }).click();
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
      .element(screen.getByRole("button", { name: "Save changes", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByLabelText("API URL", { exact: true })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: /^Delete model / }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: /^Ignore model / }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: /^Model actions for / }))
      .not.toBeInTheDocument();
    expect(state.save).not.toHaveBeenCalled();
  });
});

describe("agent model service binding", () => {
  it.each(["codex", "claudeAgent"])(
    "binds a %s instance and restores its preserved independent configuration when unbound",
    async (driver) => {
      setup({ [id]: configured });
      const update = vi.fn();
      const instance: ProviderInstanceConfig = {
        driver: ProviderDriverKind.make(driver),
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
      await screen
        .getByRole("checkbox", { name: "Use all compatible models", exact: true })
        .click();
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
    },
  );

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
