import {
  EnvironmentId,
  ModelServiceConfig,
  ModelServiceId,
  ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";
import { render, act } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { OmoSettingsSection } from "./OmoSettingsSection";
import { ModelServiceBindingSection } from "./ModelServiceBindingSection";

const state = vi.hoisted(() => ({ services: {} }));
const decodeService = Schema.decodeSync(ModelServiceConfig);
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: ((_id: unknown, selector: (settings: unknown) => unknown) =>
    selector({ modelServices: state.services })) as never,
}));

const instance: ProviderInstanceConfig = {
  driver: ProviderDriverKind.make("omo"),
  modelService: { serviceId: ModelServiceId.make("shared"), modelIds: ["Vendor/Exact", "other"] },
  config: {
    binaryPath: "custom-omo",
    agentModels: { oracle: "cox/Vendor/Exact" },
    categoryModels: {},
  },
};
const models = [
  { slug: "cox/Vendor/Exact", name: "Vendor/Exact" },
  { slug: "cox/other", name: "Other model" },
];

describe("OMO native roles", () => {
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
      config: { binaryPath: "custom-omo", agentModels: { oracle: "" }, categoryModels: {} },
    });
  });
  it("saves allowed agent/category models, custom names and empty inheritance", async () => {
    setLanguagePreference("en");
    const save = vi.fn();
    await using screen = await render(
      <OmoSettingsSection instance={instance} models={models} readOnly={false} onUpdate={save} />,
    );
    await screen.getByRole("combobox", { name: "oracle", exact: true }).selectOptions("");
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
      config: { binaryPath: "custom-omo", agentModels: { oracle: "" }, categoryModels: {} },
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
    await expect.element(screen.getByRole("textbox", { name: "Agents role name" })).toBeDisabled();
    await expect
      .element(screen.getByRole("button", { name: "Apply OMO models" }))
      .not.toBeInTheDocument();
  });
});
