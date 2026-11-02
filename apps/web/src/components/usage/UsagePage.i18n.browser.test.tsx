import { USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { UsagePage } from "./UsagePage";
import "../../index.css";

vi.mock("../../state/usage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/usage")>()),
  useUsage: () => ({
    merged: mergeUsage([], USAGE_CONTRACT_VERSION),
    environments: [],
    selectedEnvironments: [],
    shown: null,
    isPartial: false,
    refresh: async () => {},
  }),
}));

function chineseLanguage() {
  setLanguagePreference("zh");
  return {
    [Symbol.dispose]() {
      setLanguagePreference("system");
    },
  };
}

async function mobileViewport() {
  await page.viewport(390, 844);
  return { [Symbol.asyncDispose]: () => page.viewport(414, 896) };
}

it("localizes the mobile limits header, filters and empty state", async () => {
  using _language = chineseLanguage();
  await using _viewport = await mobileViewport();
  await using _screen = await render(
    <AppAtomRegistryProvider>
      <UsagePage />
    </AppAtomRegistryProvider>,
  );
  await expect.element(page.getByRole("combobox", { name: "用量指标" })).toHaveTextContent("额度");
  await expect.element(page.getByText("所有环境", { exact: true })).toBeVisible();
  await expect.element(page.getByText("所有提供商", { exact: true })).toBeVisible();
  await expect.element(page.getByText("连接环境后即可查看额度。", { exact: true })).toBeVisible();
  await act(() => {
    setLanguagePreference("en");
  });
  await expect
    .element(page.getByRole("combobox", { name: "Usage metric" }))
    .toHaveTextContent("Limits");
  await expect.element(page.getByText("All environments", { exact: true })).toBeVisible();
});
