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
import "~/index.css";

const state = vi.hoisted(() => ({ services: {} }));
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
  agentModels: { explore: "cox/Vendor/Exact" },
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

function cardHeader(card: Element) {
  return document.getElementById(card.getAttribute("aria-labelledby")!.split(" ")[0]!)!;
}

function expectSeparatedRoleCards(group: Element) {
  const cards = Array.from(group.querySelectorAll<HTMLElement>('[role="group"]'));
  for (const [index, card] of cards.entries()) {
    const style = getComputedStyle(card);
    const box = card.getBoundingClientRect();
    const header = cardHeader(card);
    expect(header.textContent).not.toBe("");
    expect(Number.parseFloat(getComputedStyle(header).fontWeight)).toBeGreaterThanOrEqual(500);
    expect(Number.parseFloat(style.borderTopWidth)).toBe(1);
    expect(Number.parseFloat(style.borderRightWidth)).toBe(1);
    expect(Number.parseFloat(style.borderBottomWidth)).toBe(1);
    expect(Number.parseFloat(style.borderLeftWidth)).toBe(1);
    expect(style.borderTopStyle).toBe("solid");
    expect(style.borderTopColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Number.parseFloat(style.borderTopLeftRadius)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(style.paddingLeft)).toBeGreaterThanOrEqual(12);
    expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
    if (index > 0) {
      expect(box.top - cards[index - 1]!.getBoundingClientRect().bottom).toBeGreaterThanOrEqual(12);
    }
  }
  return cards;
}

describe("OMO native roles", () => {
  it.each([640, 900])(
    "separates agent and category cards with aligned model and strength controls at %spx",
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
      await screen.getByRole("button", { name: /Categories/ }).click();
      for (const [title, count] of [
        ["Agents", 4],
        ["Categories", 10],
      ] as const) {
        const group = screen.getByRole("group", { name: title, exact: true }).element();
        const rows = expectSeparatedRoleCards(group);
        expect(rows).toHaveLength(count);
        const modelLeft = rows[0]!.querySelector("select")!.getBoundingClientRect().left;
        for (const row of rows) {
          const header = cardHeader(row);
          const model = row.querySelector<HTMLSelectElement>("select")!;
          const strength = row.querySelector<HTMLSelectElement>(
            'select[aria-label$="thinking strength"]',
          )!;
          const modelBox = model.getBoundingClientRect();
          const strengthBox = strength.getBoundingClientRect();
          expect(header.getBoundingClientRect().bottom).toBeLessThan(modelBox.top);
          expect(Math.abs(modelBox.left - modelLeft)).toBeLessThan(1);
          expect(strengthBox.left).toBeGreaterThan(modelBox.right);
          expect(Math.abs(modelBox.top - strengthBox.top)).toBeLessThan(1);
          expect(modelBox.height).toBeGreaterThanOrEqual(44);
          expect(strengthBox.height).toBeGreaterThanOrEqual(44);
        }
      }
      expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
      await screen
        .getByRole("combobox", { name: "explore", exact: true })
        .selectOptions("cox/other");
      await screen
        .getByRole("combobox", { name: "explore thinking strength" })
        .selectOptions("low");
      await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeEnabled();
    },
  );

  it("keeps role card boundaries and headers themed in light and dark mode", async () => {
    setLanguagePreference("en");
    await using _viewport = await sizedViewport(390);
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    await screen.getByRole("button", { name: /Categories/ }).click();
    const root = document.documentElement;
    const originalDark = root.classList.contains("dark");
    const colors: { border: string; background: string; header: string }[] = [];
    try {
      for (const dark of [false, true]) {
        root.classList.toggle("dark", dark);
        for (const title of ["Agents", "Categories"]) {
          expectSeparatedRoleCards(
            screen.getByRole("group", { name: title, exact: true }).element(),
          );
        }
        const card = screen
          .getByRole("group", { name: "Codebase search explore", exact: true })
          .element();
        const style = getComputedStyle(card);
        const header = cardHeader(card);
        colors.push({
          border: style.borderTopColor,
          background: style.backgroundColor,
          header: getComputedStyle(header).color,
        });
      }
      expect(colors[0]!.border).not.toBe(colors[1]!.border);
      expect(colors[0]!.background).not.toBe(colors[1]!.background);
      expect(colors[0]!.header).not.toBe(colors[1]!.header);
    } finally {
      root.classList.toggle("dark", originalDark);
    }
  });

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
      const customCategory = `category_${"b".repeat(55)}`;
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
        />,
      );
      const agents = screen
        .getByRole("group", { name: language === "zh" ? "Agent" : "Agents", exact: true })
        .element();
      const rows = expectSeparatedRoleCards(agents);
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        const label = cardHeader(row);
        const fields = Array.from(row.querySelectorAll("select"));
        const labels = Array.from(row.querySelectorAll("label"));
        const rowBox = row.getBoundingClientRect();
        const modelBox = fields[0]!.getBoundingClientRect();
        const strengthBox = fields[1]!.getBoundingClientRect();
        expect(
          getComputedStyle(fields[0]!.parentElement!.parentElement!).gridTemplateColumns.split(" "),
        ).toHaveLength(2);
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
      await search.fill("explore");
      await expect
        .element(screen.getByRole("group", { name: customRole, exact: true }))
        .not.toBeInTheDocument();
      await screen
        .getByRole("combobox", { name: "explore", exact: true })
        .selectOptions("cox/other");
      await screen
        .getByRole("combobox", {
          name: language === "zh" ? "explore 思考强度" : "explore thinking strength",
        })
        .selectOptions("low");
      await screen
        .getByRole("button", { name: language === "zh" ? "类别" : "Categories", exact: false })
        .click();
      const categories = screen.getByRole("group", {
        name: language === "zh" ? "类别" : "Categories",
        exact: true,
      });
      await categories
        .getByRole("textbox", { name: language === "zh" ? "类别角色名称" : "Categories role name" })
        .fill(customCategory);
      await categories
        .getByRole("button", { name: language === "zh" ? "添加角色" : "Add role", exact: true })
        .click();
      const categoryCards = expectSeparatedRoleCards(categories.element());
      expect(categoryCards).toHaveLength(11);
      for (const card of categoryCards) {
        const model = card.querySelector("select")!;
        expect(cardHeader(card).getBoundingClientRect().bottom).toBeLessThan(
          model.getBoundingClientRect().top,
        );
      }
      await screen
        .getByRole("combobox", { name: customCategory, exact: true })
        .selectOptions("cox/other");
      await screen.getByRole("combobox", { name: "quick", exact: true }).selectOptions("cox/other");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      await screen
        .getByRole("button", { name: language === "zh" ? "应用 OMO 模型" : "Apply OMO models" })
        .click();
      expect(save).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          config: expect.objectContaining({
            agentModels: { explore: "cox/other", [customRole]: "cox/other" },
            agentReasoning: { explore: "low" },
            categoryModels: { quick: "cox/other", [customCategory]: "cox/other" },
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
            agentModels: { explore: missingModel },
            agentReasoning: { explore: "max" },
            categoryReasoning: { deep: "max" },
          },
        }}
        models={[models[1]!]}
        readOnly={false}
        onUpdate={save}
      />,
    );
    const explore = screen.getByRole("combobox", { name: "explore", exact: true });
    const strength = screen.getByRole("combobox", { name: "explore thinking strength" });
    const deepStrength = screen.getByRole("combobox", { name: "deep-low thinking strength" });
    await expect.element(explore).toHaveAttribute("aria-invalid", "true");
    await expect.element(strength).toHaveAttribute("aria-invalid", "true");
    await expect.element(deepStrength).toHaveAttribute("aria-invalid", "true");
    expect(
      document.getElementById(explore.element().getAttribute("aria-describedby")!)?.textContent,
    ).toBe(`Unavailable model: ${missingModel}`);
    for (const field of [strength, deepStrength]) {
      expect(
        document.getElementById(field.element().getAttribute("aria-describedby")!)?.textContent,
      ).toBe("This thinking strength is not supported by the selected model.");
    }
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await explore.selectOptions("cox/other");
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
      expectSeparatedRoleCards(
        screen.getByRole("group", { name: "Agents", exact: true }).element(),
      );
      const group = screen.getByRole("group", { name: "Codebase search explore", exact: true });
      const model = group.getByRole("textbox", { name: "explore", exact: true });
      const strength = group.getByRole("combobox", { name: "explore thinking strength" });
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
            agentModels: { explore: "vendor/ExactModel" },
            agentReasoning: { explore: "max" },
          }),
        }),
      );
    },
  );

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
    await screen.getByRole("combobox", { name: "explore thinking strength" }).selectOptions("high");
    await screen.getByRole("button", { name: /Categories/ }).click();
    await screen.getByRole("combobox", { name: "quick thinking strength" }).selectOptions("low");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agentReasoning: { explore: "high" },
          categoryReasoning: { quick: "low" },
        }),
      }),
    );
    await screen.rerender(section("reopened"));
    await expect
      .element(screen.getByRole("combobox", { name: "explore thinking strength" }))
      .toHaveValue("high");
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("cox/other");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Clear or reassign unsupported thinking strengths before saving.");
    await screen.getByRole("combobox", { name: "explore thinking strength" }).selectOptions("low");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ agentReasoning: { explore: "low" } }),
      }),
    );
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
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    await screen.rerender(renderSection());
    await expect.element(screen.getByRole("status")).toHaveTextContent("Configuration saved");
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("cox/other");
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("cox/other");
    expect(save).toHaveBeenCalledOnce();
  });

  it("requires an explicit choice before a dirty draft can replace changed saved assignments", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("cox/other");
    const external = {
      ...instance,
      config: { binaryPath: "new-binary", agentModels: { explore: "" }, categoryModels: {} },
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
        agentModels: { explore: "cox/other" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
      },
    });
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
      'select[aria-label="explore"]',
    );
    expect(explore).toBeNull();
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
  it("keeps a failed save editable and marks saved only after a successful retry", async () => {
    setLanguagePreference("en");
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Configuration was not saved. Your draft is preserved.");
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
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
        agentModels: { explore: "cox/other" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
      },
    };
    await screen.rerender(
      <OmoSettingsSection instance={external} models={models} readOnly={false} onUpdate={save} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("cox/other");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("");
    await screen.rerender(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
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
    await screen.getByRole("textbox", { name: "Search Agents" }).fill("codebase search");
    await expect
      .element(screen.getByRole("combobox", { name: "librarian", exact: true }))
      .not.toBeInTheDocument();
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("cox/other");
    await screen.getByRole("button", { name: "Discard changes" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("cox/Vendor/Exact");
    await screen.getByRole("button", { name: /Agents/ }).click();
    await expect
      .element(screen.getByRole("button", { name: /Agents/ }))
      .toHaveAttribute("aria-expanded", "false");
  });

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
      />,
      { container },
    );
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
    await screen.getByRole("button", { name: /Agents/ }).click();
    expect(screen.container.scrollWidth).toBeLessThanOrEqual(screen.container.clientWidth);
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
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("");
    expect(save).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledExactlyOnceWith({
      ...current,
      modelService: { serviceId, modelIds: [] },
      config: {
        binaryPath: "custom-omo",
        agentModels: { explore: "" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
      },
    });
  });
  it("saves allowed agent/category models, custom names and empty inheritance", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "explore", exact: true }).selectOptions("");
    await screen.getByRole("button", { name: /Categories/ }).click();
    await screen
      .getByRole("combobox", { name: "deep-low", exact: true })
      .selectOptions("cox/other");
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
        agentModels: { explore: "", custom_agent: "cox/Vendor/Exact" },
        categoryModels: { "deep-low": "cox/other" },
        agentReasoning: {},
        categoryReasoning: {},
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
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("../explore");
    await expect
      .element(screen.getByRole("button", { name: "Add role", exact: true }).first())
      .toBeDisabled();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent(
        "Use a unique role name starting with a letter, followed by letters, digits, underscores or hyphens (up to 64 characters).",
      );
    await screen.getByRole("textbox", { name: "Agents role name" }).fill("explore");
    await expect
      .element(screen.getByRole("button", { name: "Add role", exact: true }).first())
      .toBeDisabled();
    await act(() => setLanguagePreference("zh"));
    await expect.element(screen.getByRole("button", { name: "应用 OMO 模型" })).toBeVisible();
    expect(screen.container.textContent).toContain("Vendor/Exact");
    expect(screen.container.textContent).toContain("explore");
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
    const explore = screen.getByRole("combobox", { name: "explore", exact: true });
    await expect.element(explore).toHaveValue("cox/Vendor/Exact");
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    expect(save).not.toHaveBeenCalled();
    await explore.selectOptions("");
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledWith({
      ...instance,
      config: {
        binaryPath: "custom-omo",
        agentModels: { explore: "" },
        categoryModels: {},
        agentReasoning: {},
        categoryReasoning: {},
      },
    });
  });

  it("disables all role editing for read-only settings", async () => {
    setLanguagePreference("en");
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly onUpdate={vi.fn()} />,
    );
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("combobox", { name: "explore thinking strength" }))
      .toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "Agents role name" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Apply OMO models" }))
      .not.toBeInTheDocument();
  });
  it("explains each native role with its title, summary and model advice", async () => {
    setLanguagePreference("en");
    await using screen = await render(
      <OmoSettingsSection
        instance={instance}
        models={models}
        readOnly={false}
        onUpdate={vi.fn()}
      />,
    );
    const explore = screen.getByRole("group", { name: "Codebase search explore", exact: true });
    await expect
      .element(
        explore.getByText(
          "Finds where things live in a codebase and which file holds a given behavior.",
          { exact: true },
        ),
      )
      .toBeVisible();
    await expect.element(explore.getByText("Runs often", { exact: true })).toBeVisible();
    await expect
      .element(explore.getByText("No official match in this service", { exact: true }))
      .toBeVisible();
    await explore.getByRole("button", { name: "Model advice" }).click();
    await expect
      .element(
        explore.getByText(
          "Needs speed more than intelligence; a small fast model fits, and large flagship models waste cost.",
        ),
      )
      .toBeVisible();
    await act(() => setLanguagePreference("zh"));
    await expect
      .element(screen.getByRole("group", { name: "代码库搜索 explore", exact: true }))
      .toBeVisible();
    await screen.getByRole("textbox", { name: "搜索Agent" }).fill("远程代码库");
    await expect
      .element(screen.getByRole("combobox", { name: "librarian", exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .not.toBeInTheDocument();
    await act(() => setLanguagePreference("en"));
  });

  it("fills native roles from official recommendations after confirming a dirty draft", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    const catalog = [
      {
        slug: "cox/gpt-6-astra",
        name: "GPT-6 Astra",
        reasoningLevels: ["low", "medium", "high", "xhigh"] as const,
      },
      {
        slug: "cox/claude-haiku-5-5",
        name: "Claude Haiku 5.5",
        reasoningLevels: ["off", "low", "medium", "high"] as const,
      },
    ];
    await using screen = await render(
      <OmoSettingsSection
        instance={{
          ...instance,
          config: { ...instanceConfig, agentModels: { explore: "cox/gpt-6-astra" } },
        }}
        models={catalog}
        readOnly={false}
        onUpdate={save}
      />,
    );
    await expect
      .element(
        screen
          .getByRole("group", { name: "Plan review plan-reviewer", exact: true })
          .getByText("Recommended: GPT-6 Astra · xhigh", { exact: true }),
      )
      .toBeVisible();
    await screen
      .getByRole("combobox", { name: "librarian", exact: true })
      .selectOptions("cox/gpt-6-astra");
    await screen.getByRole("button", { name: "Apply official recommendations" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "librarian", exact: true }))
      .toHaveValue("cox/gpt-6-astra");
    await screen.getByRole("button", { name: "Replace with official recommendations" }).click();
    await expect
      .element(screen.getByRole("combobox", { name: "plan-reviewer", exact: true }))
      .toHaveValue("cox/gpt-6-astra");
    await expect
      .element(screen.getByRole("combobox", { name: "plan-reviewer thinking strength" }))
      .toHaveValue("xhigh");
    await expect
      .element(screen.getByRole("combobox", { name: "explore", exact: true }))
      .toHaveValue("cox/claude-haiku-5-5");
    await expect
      .element(screen.getByRole("combobox", { name: "explore thinking strength" }))
      .toHaveValue("medium");
    await expect
      .element(screen.getByText(/Left unchanged, no official match in this service:/))
      .toHaveTextContent(
        "Official recommendations added to the draft. Left unchanged, no official match in this service: " +
          "plan-consultant, visual-engineering, architect, deep-low, artistry, unspecified-low, unspecified-high, writing",
      );
    await expect
      .element(screen.getByRole("button", { name: "Use recommended model for explore" }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("combobox", { name: "plan-consultant", exact: true }))
      .toHaveValue("");
    expect(save).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agentModels: {
            explore: "cox/claude-haiku-5-5",
            librarian: "cox/claude-haiku-5-5",
            "plan-reviewer": "cox/gpt-6-astra",
          },
          agentReasoning: { explore: "medium", librarian: "medium", "plan-reviewer": "xhigh" },
        }),
      }),
    );
  });

  it("lists saved legacy agents separately and removes them only from the draft", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection
        instance={{
          ...instance,
          config: {
            ...instanceConfig,
            agentModels: { ...instanceConfig.agentModels, sisyphus: "cox/other" },
            agentReasoning: { sisyphus: "low" },
          },
        }}
        models={models}
        readOnly={false}
        onUpdate={save}
      />,
    );
    const legacy = screen.getByRole("group", { name: "Not used by OMO Native", exact: true });
    await expect.element(legacy.getByText("sisyphus", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("combobox", { name: "sisyphus", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Apply OMO models" })).toBeDisabled();
    await legacy.getByRole("button", { name: "Remove sisyphus" }).click();
    await expect.element(legacy).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Apply OMO models" }).click();
    expect(save).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        config: expect.objectContaining({
          agentModels: { explore: "cox/Vendor/Exact" },
          agentReasoning: {},
        }),
      }),
    );
  });
});
