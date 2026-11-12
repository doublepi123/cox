import {
  EnvironmentId,
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render, act } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { OmoSettingsSection } from "./OmoSettingsSection";
import { ModelServiceBindingSection } from "./ModelServiceBindingSection";
import { DEFAULT_OMO_RECOMMENDATION_PROMPT } from "@t3tools/shared/omoRecommendations";
import "~/index.css";

const state = vi.hoisted(() => ({ services: {}, recommend: vi.fn() }));
vi.mock(import("../../environments/primary/httpLayer"), async () => {
  const { layerRemoteHttpClient } = await import("@t3tools/client-runtime/rpc");
  const Layer = await import("effect/Layer");
  const { FetchHttpClient } = await import("effect/http");
  return {
    layer: Layer.merge(
      layerRemoteHttpClient(async () => new Response(null, { status: 503 })),
      Layer.succeed(FetchHttpClient.RequestInit, { credentials: "same-origin" }),
    ),
  };
});
vi.mock(import("../../state/server"), async (original) => ({
  ...(await original()),
  serverEnvironment: {
    ...(await original()).serverEnvironment,
    recommendOmoModels: state.recommend as never,
  },
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
const decodeService = Schema.decodeSync(ModelServiceConfig);
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, selector: (settings: unknown) => unknown) =>
    selector({ modelServices: state.services })) as never,
}));

const instanceConfig = {
  binaryPath: "custom-omo",
  agentModels: { oracle: "cox/Vendor/Exact" },
  categoryModels: {},
  agentReasoning: {},
  categoryReasoning: {},
};
const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("omo"),
  modelService: { serviceId: ModelServiceId.make("shared"), modelIds: ["Vendor/Exact", "other"] },
  config: instanceConfig,
};
const models = [
  {
    slug: "cox/Vendor/Exact",
    name: "Vendor/Exact",
    reasoningLevels: ["low", "high", "max"] as const,
  },
  { slug: "cox/other", name: "Other model", reasoningLevels: ["off", "low"] as const },
];

async function sizedViewport(width: number) {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  await page.viewport(width, 900);
  return {
    async [Symbol.asyncDispose]() {
      await page.viewport(originalWidth, originalHeight);
    },
  };
}

describe("OMO native roles", () => {
  it.each([640, 900])(
    "fits ten agents in compact, separated three-column rows at %spx",
    async (width) => {
      setLanguagePreference("en");
      await using _viewport = await sizedViewport(1280);
      const container = document.createElement("div");
      container.style.width = `${width}px`;
      await using screen = await render(
        <OmoSettingsSection
          instance={instance}
          models={models}
          readOnly={false}
          onUpdate={vi.fn()}
        />,
        { container },
      );
      const agents = screen.getByRole("group", { name: "Agents", exact: true }).element();
      const rows = Array.from(agents.querySelectorAll<HTMLElement>('[role="group"]'));
      expect(rows).toHaveLength(10);
      const heading = rows[0]!.previousElementSibling!;
      expect(getComputedStyle(heading).display).toBe("grid");
      expect(Array.from(heading.children, (element) => element.textContent)).toEqual([
        "Role",
        "Model",
        "Thinking strength",
      ]);
      const columns = Array.from(heading.children, (element) => element.getBoundingClientRect());
      for (const [index, row] of rows.entries()) {
        const label = row.querySelector<HTMLElement>(":scope > span")!;
        const model = row.querySelector<HTMLSelectElement>("select")!;
        const strength = row.querySelector<HTMLSelectElement>(
          'select[aria-label$="thinking strength"]',
        )!;
        const rowBox = row.getBoundingClientRect();
        const roleBox = label.getBoundingClientRect();
        const modelBox = model.getBoundingClientRect();
        const strengthBox = strength.getBoundingClientRect();
        expect(getComputedStyle(row).gridTemplateColumns.split(" ")).toHaveLength(3);
        expect(roleBox.width).toBeLessThanOrEqual(160);
        expect(roleBox.width / rowBox.width).toBeLessThan(0.3);
        expect(Math.abs(roleBox.left - columns[0]!.left)).toBeLessThan(1);
        expect(Math.abs(modelBox.left - columns[1]!.left)).toBeLessThan(1);
        expect(Math.abs(strengthBox.left - columns[2]!.left)).toBeLessThan(1);
        expect(modelBox.left).toBeGreaterThan(roleBox.right);
        expect(strengthBox.left).toBeGreaterThan(modelBox.right);
        expect(Math.abs(modelBox.top - strengthBox.top)).toBeLessThan(1);
        expect(modelBox.height).toBeGreaterThanOrEqual(44);
        expect(strengthBox.height).toBeGreaterThanOrEqual(44);
        expect(rowBox.height).toBeLessThanOrEqual(64);
        if (index < rows.length - 1) {
          expect(Number.parseFloat(getComputedStyle(row).borderBottomWidth)).toBe(1);
        }
      }
      expect(
        rows.at(-1)!.getBoundingClientRect().bottom - rows[0]!.getBoundingClientRect().top,
      ).toBeLessThanOrEqual(640);
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
      await screen
        .getByRole("combobox", { name: "oracle", exact: true })
        .selectOptions("cox/other");
      await screen.getByRole("combobox", { name: "oracle thinking strength" }).selectOptions("low");
      await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeEnabled();
    },
  );

  it.each([
    { width: 320, language: "en" as const },
    { width: 360, language: "zh" as const },
    { width: 390, language: "en" as const },
  ])(
    "groups touch-sized role controls without overflow at $width px in $language",
    async ({ width, language }) => {
      setLanguagePreference(language);
      await using _viewport = await sizedViewport(width);
      const save = vi.fn();
      const customRole = `custom_${"a".repeat(57)}`;
      const longModels = models.map((model) => ({
        ...model,
        name: "LongModelName".repeat(40),
      }));
      await using screen = await render(
        <OmoSettingsSection
          instance={{
            ...instance,
            config: {
              ...instanceConfig,
              agentModels: { ...instanceConfig.agentModels, [customRole]: "cox/other" },
            },
          }}
          models={longModels}
          readOnly={false}
          onUpdate={save}
          environmentId={EnvironmentId.make("test")}
          serviceRevision={3}
        />,
      );
      const agents = screen
        .getByRole("group", { name: language === "zh" ? "Agent" : "Agents", exact: true })
        .element();
      const rows = Array.from(agents.querySelectorAll<HTMLElement>('[role="group"]'));
      expect(rows).toHaveLength(11);
      expect(getComputedStyle(rows[0]!.previousElementSibling!).display).toBe("none");
      for (const row of rows) {
        const label = row.querySelector<HTMLElement>(":scope > span")!;
        const fields = Array.from(row.querySelectorAll("select"));
        const labels = Array.from(row.querySelectorAll("label"));
        const rowBox = row.getBoundingClientRect();
        const modelBox = fields[0]!.getBoundingClientRect();
        const strengthBox = fields[1]!.getBoundingClientRect();
        expect(getComputedStyle(row).gridTemplateColumns.split(" ")).toHaveLength(2);
        expect(labels.map((element) => element.textContent)).toEqual(
          language === "zh" ? ["模型", "思考强度"] : ["Model", "Thinking strength"],
        );
        expect(label.getBoundingClientRect().bottom).toBeLessThan(modelBox.top);
        expect(Math.abs(modelBox.top - strengthBox.top)).toBeLessThan(1);
        expect(strengthBox.left).toBeGreaterThan(modelBox.right);
        for (const field of fields) {
          const box = field.getBoundingClientRect();
          expect(box.height).toBeGreaterThanOrEqual(44);
          expect(box.left).toBeGreaterThanOrEqual(rowBox.left);
          expect(box.right).toBeLessThanOrEqual(rowBox.right + 1);
        }
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      }
      for (const input of agents.querySelectorAll("input")) {
        expect(input.closest("label")!.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      const buttons = [
        ...screen.container.querySelectorAll<HTMLButtonElement>(
          '[data-slot="collapsible-trigger"], fieldset button',
        ),
        ...screen
          .getByRole("button", {
            name: language === "zh" ? "应用 OMO 模型" : "Apply OMO models",
          })
          .elements(),
        ...screen
          .getByRole("button", {
            name: language === "zh" ? "丢弃更改" : "Discard changes",
          })
          .elements(),
      ];
      for (const button of buttons) {
        expect(button.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      }
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const search = screen.getByRole("textbox", {
        name: language === "zh" ? "搜索Agent" : "Search Agents",
      });
      await search.fill("oracle");
      await expect
        .element(screen.getByRole("group", { name: customRole, exact: true }))
        .not.toBeInTheDocument();
      await screen
        .getByRole("combobox", { name: "oracle", exact: true })
        .selectOptions("cox/other");
      await screen
        .getByRole("combobox", {
          name: language === "zh" ? "oracle 思考强度" : "oracle thinking strength",
        })
        .selectOptions("low");
      await screen
        .getByRole("button", { name: language === "zh" ? "类别" : "Categories", exact: false })
        .click();
      await screen.getByRole("combobox", { name: "quick", exact: true }).selectOptions("cox/other");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await screen
        .getByRole("button", { name: language === "zh" ? "应用 OMO 模型" : "Apply OMO models" })
        .click();
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config: expect.objectContaining({
            agentModels: { oracle: "cox/other", [customRole]: "cox/other" },
            agentReasoning: { oracle: "low" },
            categoryModels: { quick: "cox/other" },
          }),
        }),
      );
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
    },
  );

  it("keeps unavailable model and strength errors associated with their fields on narrow screens", async () => {
    setLanguagePreference("en");
    await using _viewport = await sizedViewport(390);
    const missingModel = `cox/${"UnavailableModel".repeat(20)}`;
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection
        instance={{
          ...instance,
          config: {
            ...instanceConfig,
            agentModels: { oracle: missingModel },
            agentReasoning: { oracle: "max" },
            categoryReasoning: { deep: "max" },
          },
        }}
        models={[models[1]!]}
        readOnly={false}
        onUpdate={save}
      />,
    );
    const oracle = screen.getByRole("combobox", { name: "oracle", exact: true });
    const strength = screen.getByRole("combobox", { name: "oracle thinking strength" });
    const deepStrength = screen.getByRole("combobox", { name: "deep thinking strength" });
    await expect.element(oracle).toHaveAttribute("aria-invalid", "true");
    await expect.element(strength).toHaveAttribute("aria-invalid", "true");
    await expect.element(deepStrength).toHaveAttribute("aria-invalid", "true");
    expect(
      document.getElementById(oracle.element().getAttribute("aria-describedby")!)?.textContent,
    ).toBe(`Unavailable model: ${missingModel}`);
    for (const field of [strength, deepStrength]) {
      expect(
        document.getElementById(field.element().getAttribute("aria-describedby")!)?.textContent,
      ).toBe("This thinking strength is not supported by the selected model.");
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await oracle.selectOptions("cox/other");
    await strength.selectOptions("low");
    await deepStrength.selectOptions("");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([390, 900])(
    "keeps independent model inputs grouped and touch-accessible at %spx",
    async (width) => {
      setLanguagePreference("en");
      await using _viewport = await sizedViewport(width);
      const save = vi.fn();
      const { modelService: _binding, ...independent } = instance;
      await using screen = await render(
        <OmoSettingsSection
          instance={{ ...independent, config: { model: "vendor/native-model" } }}
          models={[]}
          readOnly={false}
          onUpdate={save}
        />,
      );
      const group = screen.getByRole("group", { name: "oracle", exact: true });
      const model = group.getByRole("textbox", { name: "oracle", exact: true });
      const strength = group.getByRole("combobox", { name: "oracle thinking strength" });
      const touchTarget = model.element().closest("label")!;
      const targetBox = touchTarget.getBoundingClientRect();
      const strengthBox = strength.element().getBoundingClientRect();
      expect(targetBox.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(targetBox.top - strengthBox.top)).toBeLessThan(1);
      await page.elementLocator(touchTarget).click({ position: { x: 2, y: 2 } });
      await expect.element(model).toHaveFocus();
      await model.fill("vendor/ExactModel");
      await strength.selectOptions("max");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await screen.getByRole("button", { name: "Apply OMO models" }).click();
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config: expect.objectContaining({
            model: "vendor/native-model",
            agentModels: { oracle: "vendor/ExactModel" },
            agentReasoning: { oracle: "max" },
          }),
        }),
      );
    },
  );

  it("applies recommended thinking strengths and keeps manual strength edits", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    state.recommend.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        agentModels: { oracle: "cox/Vendor/Exact" },
        categoryModels: { quick: "cox/other" },
        agentReasoning: { oracle: "high" },
        categoryReasoning: { quick: "off" },
        explanation: "Use deeper review and quick simple work.",
      },
    });
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={save}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle thinking strength" }))
      .toHaveValue("high");
    await expect
      .element(screen.getByRole("combobox", { name: "quick thinking strength" }))
      .toHaveValue("off");
    await screen.getByRole("combobox", { name: "oracle thinking strength" }).selectOptions("max");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agentReasoning: { oracle: "max" },
          categoryReasoning: { quick: "off" },
        }),
      }),
    );
  });
  it("saves agent and category thinking strengths and rejects an incompatible model change", async () => {
    setLanguagePreference("en");
    let echoed = instance;
    const save = vi.fn(async (next: ProviderInstanceConfig) => {
      echoed = next;
      return true;
    });
    const section = (key: string) => (
      <OmoSettingsSection
        key={key}
        instance={echoed}
        models={models}
        readOnly={false}
        onUpdate={save}
      />
    );
    await using screen = await render(section("initial"));
    await screen.getByRole("combobox", { name: "oracle thinking strength" }).selectOptions("high");
    await screen.getByRole("button", { name: /Categories/ }).click();
    await screen.getByRole("combobox", { name: "quick thinking strength" }).selectOptions("low");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agentReasoning: { oracle: "high" },
          categoryReasoning: { quick: "low" },
        }),
      }),
    );
    await screen.rerender(section("reopened"));
    await expect
      .element(screen.getByRole("combobox", { name: "oracle thinking strength" }))
      .toHaveValue("high");
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Clear or reassign unsupported thinking strengths before saving.");
    await screen.getByRole("combobox", { name: "oracle thinking strength" }).selectOptions("low");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ agentReasoning: { oracle: "low" } }),
      }),
    );
  });

  it("keeps a thinking-strength edit made while recommendations are pending", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.getByRole("combobox", { name: "oracle thinking strength" }).selectOptions("max");
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: { oracle: "cox/other" },
          categoryModels: {},
          agentReasoning: { oracle: "low" },
          categoryReasoning: {},
          explanation: "Stale strengths",
        },
      }),
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The configuration changed during generation. Generate again for the current draft.",
      );
    await expect
      .element(screen.getByRole("combobox", { name: "oracle thinking strength" }))
      .toHaveValue("max");
  });
  it.each(["", " \n\t "])(
    "saves a custom prompt across reopening and clears it to the default: %j",
    async (cleared) => {
      setLanguagePreference("en");
      let echoed = instance;
      const save = vi.fn(async (next: ProviderInstanceConfig) => {
        echoed = next;
        return true;
      });
      const renderSection = (key: string) => (
        <OmoSettingsSection
          key={key}
          instance={echoed}
          models={models}
          readOnly={false}
          onUpdate={save}
          environmentId={EnvironmentId.make("test")}
          serviceRevision={3}
        />
      );
      await using screen = await render(renderSection("initial"));
      const prompt = screen.getByRole("textbox", { name: "Recommendation prompt" });
      await expect.element(prompt).toHaveValue(DEFAULT_OMO_RECOMMENDATION_PROMPT);
      await prompt.fill("Prefer accurate coding models and efficient repository search.");
      await screen.getByRole("button", { name: "Apply OMO models" }).click();
      expect(save).toHaveBeenLastCalledWith({
        ...instance,
        config: {
          ...instanceConfig,
          recommendationPrompt: "Prefer accurate coding models and efficient repository search.",
        },
      });
      await screen.rerender(renderSection("reopened"));
      await expect
        .element(prompt)
        .toHaveValue("Prefer accurate coding models and efficient repository search.");
      await prompt.fill(cleared);
      await screen.getByRole("button", { name: "Apply OMO models" }).click();
      await expect.element(prompt).toHaveValue(DEFAULT_OMO_RECOMMENDATION_PROMPT);
      expect(save).toHaveBeenLastCalledWith({
        ...instance,
        config: { ...instanceConfig, recommendationPrompt: "" },
      });
      await screen.rerender(renderSection("reset-reopened"));
      await expect.element(prompt).toHaveValue(DEFAULT_OMO_RECOMMENDATION_PROMPT);
      expect(save).toHaveBeenCalledTimes(2);
    },
  );

  it("uses the edited prompt for generation without saving it automatically", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    state.recommend.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        agentModels: { oracle: "cox/other" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
        explanation: "Custom prompt result",
      },
    });
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={save}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen
      .getByRole("textbox", { name: "Recommendation prompt" })
      .fill("Prioritize precise architecture review.");
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.getByRole("button", { name: "Generate and replace current draft" }).click();
    expect(state.recommend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ prompt: "Prioritize precise architecture review." }),
      }),
    );
    await expect.element(screen.getByText("Custom prompt result", { exact: true })).toBeVisible();
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves prompt edits and rejects a recommendation generated with an older prompt", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen
      .getByRole("textbox", { name: "Recommendation prompt" })
      .fill("New role selection requirements.");
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: { oracle: "cox/other" },
          categoryModels: {},
          agentReasoning: {},
          categoryReasoning: {},
          explanation: "Old prompt result",
        },
      }),
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The configuration changed during generation. Generate again for the current draft.",
      );
    await expect
      .element(screen.getByRole("textbox", { name: "Recommendation prompt" }))
      .toHaveValue("New role selection requirements.");
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
  });

  it("protects a prompt draft from external saved updates and loads them on discard", async () => {
    setLanguagePreference("en");
    const section = (source: ProviderInstanceConfig) => (
      <OmoSettingsSection
        instance={source}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />
    );
    await using screen = await render(section(instance));
    await screen.getByRole("textbox", { name: "Recommendation prompt" }).fill("My unsaved prompt.");
    await screen.rerender(
      section({
        ...instance,
        config: { ...instanceConfig, recommendationPrompt: "Saved elsewhere." },
      }),
    );
    await expect
      .element(screen.getByRole("textbox", { name: "Recommendation prompt" }))
      .toHaveValue("My unsaved prompt.");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("textbox", { name: "Recommendation prompt" }))
      .toHaveValue("Saved elsewhere.");
  });

  it("disables prompt editing in read-only settings", async () => {
    setLanguagePreference("en");
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await expect
      .element(screen.getByRole("textbox", { name: "Recommendation prompt" }))
      .toBeDisabled();
  });

  it("keeps saved role values through a real binding-section save echo and later discard", async () => {
    setLanguagePreference("en");
    state.services = {
      shared: decodeService({
        name: "Shared",
        baseUrl: "https://models.test/v1",
        protocols: ["openai-chat"],
        models: [{ id: "Vendor/Exact" }, { id: "other" }],
      }),
    };
    let echoed = instance;
    const save = vi.fn(async (next: ProviderInstanceConfig) => {
      echoed = next;
      return true;
    });
    const renderSection = () => (
      <ModelServiceBindingSection
        environmentId={EnvironmentId.make("test")}
        instance={echoed}
        readOnly={false}
        onUpdate={save}
      />
    );
    await using screen = await render(renderSection());
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    await screen.rerender(renderSection());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Configuration saved");
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    expect(save).toHaveBeenCalledOnce();
  });

  it("requires an explicit choice before a dirty draft can replace changed saved assignments", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    const external = {
      ...instance,
      config: { binaryPath: "new-binary", agentModels: { oracle: "" }, categoryModels: {} },
    };
    await screen.rerender(
      <OmoSettingsSection instance={external} models={models} readOnly={false} onUpdate={save} />,
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "Saved OMO configuration changed elsewhere. Discard to load it, or keep this draft and apply it explicitly.",
      );
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("button", { name: "Keep my draft for review" }).click();
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith({
      ...external,
      config: {
        binaryPath: "new-binary",
        agentModels: { oracle: "cox/other" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
        recommendationPrompt: "",
      },
    });
  });

  it("does not insert an old result or explanation after the edited instance is replaced", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await using screen = await render(
      <OmoSettingsSection
        key="first"
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.rerender(
      <OmoSettingsSection
        key="second"
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("second")}
        serviceRevision={3}
      />,
    );
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: { oracle: "cox/other" },
          categoryModels: {},
          agentReasoning: {},
          categoryReasoning: {},
          explanation: "Old instance explanation",
        },
      }),
    );
    await expect
      .element(screen.getByText("Old instance explanation", { exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
  });

  it("shows the independently configured main model instead of a bound catalog fallback", async () => {
    setLanguagePreference("en");
    const { modelService: _binding, ...independent } = instance;
    await using screen = await render(
      <OmoSettingsSection
        instance={{ ...independent, config: { model: "vendor/native-model" } }}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    const explore = screen.container.querySelector<HTMLSelectElement>(
      'select[aria-label="oracle"]',
    );
    expect(explore).toBeNull();
    expect(screen.container.textContent).toContain(
      "Bind a model service to use AI recommendations.",
    );
    await screen.rerender(
      <OmoSettingsSection
        instance={{
          ...instance,
          modelService: { ...instance.modelService!, defaultModel: "missing" },
        }}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.container.querySelector<HTMLSelectElement>("select")?.options[0]?.text).toBe(
      "Inherit main model",
    );
  });
  it("confirms replacement of manual changes and can keep the current draft", async () => {
    setLanguagePreference("en");
    state.recommend.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        agentModels: { oracle: "cox/Vendor/Exact" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
        explanation: "New recommendation",
      },
    });
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    expect(state.recommend).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Keep current draft" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.getByRole("button", { name: "Generate and replace current draft" }).click();
    expect(state.recommend).toHaveBeenCalledOnce();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
  });

  it("blocks applying during generation and rejects a result if a custom role was added", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await expect
      .element(screen.getByRole("button", { name: "Generating recommendations…" }))
      .toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("custom_agent");
    await screen.getByRole("button", { name: "Add role", exact: true }).click();
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: {},
          categoryModels: {},
          agentReasoning: {},
          categoryReasoning: {},
          explanation: "Stale",
        },
      }),
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The configuration changed during generation. Generate again for the current draft.",
      );
    await expect
      .element(screen.getByRole("combobox", { name: "custom_agent", exact: true }))
      .toHaveValue("");
  });

  it("keeps a failed save editable and marks saved only after a successful retry", async () => {
    setLanguagePreference("en");
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Configuration was not saved. Your draft is preserved.");
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    await screen.getByRole("button", { name: "Retry saving" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Configuration saved");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("follows saved updates when clean and preserves a dirty draft until it is discarded", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    const external = {
      ...instance,
      config: {
        binaryPath: "custom-omo",
        agentModels: { oracle: "cox/other" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
      },
    };
    await screen.rerender(
      <OmoSettingsSection instance={external} models={models} readOnly={false} onUpdate={save} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("");
    await screen.rerender(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
    expect(save).not.toHaveBeenCalled();
  });

  it("can discard a role draft and search or collapse long role groups", async () => {
    setLanguagePreference("en");
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    await screen.getByRole("textbox", { name: "Search Agents" }).fill("oracle");
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
    await screen.getByRole("button", { name: /Agents/ }).click();
    await expect
      .element(screen.getByRole("button", { name: /Agents/ }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it.each([false, true])(
    "explains why generation is unavailable (disabled service: %s)",
    async (disabled) => {
      setLanguagePreference("en");
      state.recommend.mockReset();
      await using screen = await render(
        <OmoSettingsSection
          instance={instance}
          models={disabled ? models : []}
          serviceEnabled={!disabled}
          readOnly={false}
          onUpdate={vi.fn()}
          environmentId={EnvironmentId.make("test")}
          serviceRevision={3}
        />,
      );
      await expect
        .element(screen.getByRole("button", { name: "Generate recommendation draft" }))
        .toBeDisabled();
      expect(screen.container.textContent).toContain(
        disabled ? "This model service is disabled." : "This binding has no available models.",
      );
      expect(state.recommend).not.toHaveBeenCalled();
    },
  );

  it.each([360, 900])("keeps long model names within a %spx settings container", async (width) => {
    setLanguagePreference("en");
    const container = document.createElement("div");
    container.style.width = `${width}px`;
    container.style.maxWidth = "100%";
    const longModels = models.map((model) => ({ ...model, name: "LongModelName".repeat(40) }));
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={longModels}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
      { container },
    );
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
    await screen.getByRole("button", { name: /Agents/ }).click();
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
  });
  it("generates a draft from the bound catalog and lets the user edit it before applying", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    state.recommend.mockReset().mockResolvedValue({
      _tag: "Success",
      value: {
        agentModels: { oracle: "cox/other", explore: "cox/other" },
        categoryModels: { deep: "cox/Vendor/Exact" },
        agentReasoning: {},
        categoryReasoning: {},
        explanation: "Use the stronger model for deep work.",
      },
    });
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={save}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen
      .getByRole("combobox", { name: "Recommendation model", exact: true })
      .selectOptions("cox/other");
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await expect
      .element(screen.getByText("Use the stronger model for deep work.", { exact: true }))
      .toBeVisible();
    expect(state.recommend).toHaveBeenCalledWith({
      environmentId: "test",
      input: {
        serviceId: "shared",
        revision: 3,
        modelId: "other",
        binding: instance.modelService,
        agents: expect.arrayContaining(["oracle", "explore"]),
        categories: expect.arrayContaining(["deep", "quick"]),
        prompt: DEFAULT_OMO_RECOMMENDATION_PROMPT,
      },
    });
    expect(save).not.toHaveBeenCalled();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    await screen
      .getByRole("combobox", { name: "oracle", exact: true })
      .selectOptions("cox/Vendor/Exact");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith({
      ...instance,
      config: {
        binaryPath: "custom-omo",
        agentModels: { oracle: "cox/Vendor/Exact", explore: "cox/other" },
        categoryModels: { deep: "cox/Vendor/Exact" },
        agentReasoning: {},
        categoryReasoning: {},
        recommendationPrompt: "",
      },
    });
  });

  it("preserves edits made while a recommendation request is pending", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={save}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("cox/other");
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: { oracle: "cox/Vendor/Exact" },
          categoryModels: {},
          agentReasoning: {},
          categoryReasoning: {},
          explanation: "Old draft",
        },
      }),
    );
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "The configuration changed during generation. Generate again for the current draft.",
      );
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/other");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps the previous draft after generation fails", async () => {
    setLanguagePreference("en");
    state.recommend.mockReset().mockRejectedValue(new Error("Upstream unavailable"));
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Upstream unavailable");
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
  });

  it("discards recommendations if the service binding changes during generation", async () => {
    setLanguagePreference("en");
    let finish: (result: unknown) => void = () => {};
    state.recommend.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const save = vi.fn();
    const props = {
      models,
      readOnly: false,
      onUpdate: save,
      environmentId: EnvironmentId.make("test"),
      serviceRevision: 3,
    };
    await using screen = await render(<OmoSettingsSection {...props} instance={instance} />);
    await screen.getByRole("button", { name: "Generate recommendation draft" }).click();
    await screen.rerender(
      <OmoSettingsSection
        {...props}
        instance={{ ...instance, modelService: { ...instance.modelService!, modelIds: ["other"] } }}
        models={[models[1]!]}
      />,
    );
    await act(() =>
      finish({
        _tag: "Success",
        value: {
          agentModels: { oracle: "cox/other" },
          categoryModels: {},
          agentReasoning: {},
          categoryReasoning: {},
          explanation: "Old binding",
        },
      }),
    );
    await expect
      .element(screen.getByRole("alert").first())
      .toHaveTextContent(
        "The configuration changed during generation. Generate again for the current draft.",
      );
    expect(save).not.toHaveBeenCalled();
  });

  it("disables generation when settings are read-only", async () => {
    setLanguagePreference("en");
    state.recommend.mockReset();
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly
        onUpdate={vi.fn()}
        environmentId={EnvironmentId.make("test")}
        serviceRevision={3}
      />,
    );
    await expect
      .element(screen.getByRole("button", { name: "Generate recommendation draft" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("combobox", { name: "Recommendation model", exact: true }))
      .toBeDisabled();
    expect(state.recommend).not.toHaveBeenCalled();
  });
  it("repairs unavailable main and role selections together in one settings update", async () => {
    setLanguagePreference("en");
    const serviceId = ModelServiceId.make("shared");
    state.services = {
      [serviceId]: decodeService({
        name: "Shared",
        baseUrl: "https://models.test/v1",
        protocols: ["openai-chat"],
        models: [{ id: "Vendor/Exact", available: false }, { id: "other" }],
      }),
    };
    const current = {
      ...instance,
      modelService: { serviceId, modelIds: [], defaultModel: "Vendor/Exact" },
    };
    const save = vi.fn();
    await using screen = await render(
      <ModelServiceBindingSection
        environmentId={EnvironmentId.make("test")}
        instance={current}
        readOnly={false}
        onUpdate={save}
      />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "Default model", exact: true }))
      .toHaveValue("Vendor/Exact");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("combobox", { name: "Default model", exact: true }).selectOptions("");
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("");
    expect(save).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      ...current,
      modelService: { serviceId, modelIds: [] },
      config: {
        binaryPath: "custom-omo",
        agentModels: { oracle: "" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
        recommendationPrompt: "",
      },
    });
  });
  it("saves allowed agent/category models, custom names and empty inheritance", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("");
    await screen.getByRole("button", { name: /Categories/ }).click();
    await screen.getByRole("combobox", { name: "deep", exact: true }).selectOptions("cox/other");
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("custom_agent");
    await screen.getByRole("button", { name: "Add role", exact: true }).first().click();
    await screen
      .getByRole("combobox", { name: "custom_agent", exact: true })
      .selectOptions("cox/Vendor/Exact");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith({
      ...instance,
      config: {
        binaryPath: "custom-omo",
        agentModels: { oracle: "", custom_agent: "cox/Vendor/Exact" },
        categoryModels: { deep: "cox/other" },
        agentReasoning: {},
        categoryReasoning: {},
        recommendationPrompt: "",
      },
    });
    const options = screen.container.querySelector<HTMLSelectElement>("select")!.options;
    expect([...options].map((option) => option.value)).toEqual([
      "",
      "cox/Vendor/Exact",
      "cox/other",
    ]);
  });

  it("validates custom role names and keeps raw content while changing interface language", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("../oracle");
    await expect
      .element(screen.getByRole("button", { name: "Add role", exact: true }).first())
      .toBeDisabled();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "Use a unique role name starting with a letter, followed by letters, digits, underscores or hyphens (up to 64 characters).",
      );
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("oracle");
    await expect
      .element(screen.getByRole("button", { name: "Add role", exact: true }).first())
      .toBeDisabled();
    await act(() => setLanguagePreference("zh"));
    await expect.element(screen.getByRole("button", { name: "应用 OMO 模型" })).toBeVisible();
    expect(screen.container.textContent).toContain("Vendor/Exact");
    expect(screen.container.textContent).toContain("oracle");
    await act(() => setLanguagePreference("en"));
    expect(save).not.toHaveBeenCalled();
  });

  it("retains an unavailable explicit role until the user clears it", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={[models[1]!]}
        readOnly={false}
        onUpdate={save}
      />,
    );
    const oracle = screen.getByRole("combobox", { name: "oracle", exact: true });
    await expect.element(oracle).toHaveValue("cox/Vendor/Exact");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    await oracle.selectOptions("");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith({
      ...instance,
      config: {
        binaryPath: "custom-omo",
        agentModels: { oracle: "" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
        recommendationPrompt: "",
      },
    });
  });

  it("disables all role editing for read-only settings", async () => {
    setLanguagePreference("en");
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly onUpdate={vi.fn()} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "oracle", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("combobox", { name: "oracle thinking strength" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "Agents role name" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Apply OMO models" }))
      .not.toBeInTheDocument();
  });
});
