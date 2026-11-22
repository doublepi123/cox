import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { type ComponentProps, useState } from "react";
import { expect, it } from "vite-plus/test";
import "~/index.css";

import { render } from "../../../test/render";
import { ProviderModelsSection } from "./ProviderModelsSection";

function section(props: Partial<ComponentProps<typeof ProviderModelsSection>>) {
  return (
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={async () => true}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
      {...props}
    />
  );
}

const models: ServerProviderModel[] = ["a", "b", "c", "d", "e"].map((id) => ({
  slug: `model-${id}`,
  name: `Model ${id.toUpperCase()}`,
  isCustom: false,
  capabilities: null,
}));

function StatefulModelsSection() {
  const [hiddenModels, setHiddenModels] = useState<ReadonlyArray<string>>(
    models.map((model) => model.slug),
  );
  return section({ models, hiddenModels, onHiddenModelsChange: setHiddenModels });
}

const rowSlugs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-model-slug]"), (row) =>
    row.getAttribute("data-model-slug"),
  );

it("keeps a model in place when it is shown again after disabling all", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const order = models.map((model) => model.slug);
  expect(rowSlugs(screen.container)).toEqual(order);

  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(order);
});

it("regroups the list when all models are disabled and enabled again", async () => {
  await using screen = await render(<StatefulModelsSection />);
  const toggle = screen.getByRole("switch", { name: "Show Model C in the model picker" });
  await toggle.click();
  await expect.element(toggle).toBeChecked();

  await screen.getByRole("button", { name: "Disable all" }).click();
  await screen.getByRole("button", { name: "Enable all" }).click();
  await expect.element(toggle).toBeChecked();

  expect(rowSlugs(screen.container)).toEqual(models.map((model) => model.slug));
});
