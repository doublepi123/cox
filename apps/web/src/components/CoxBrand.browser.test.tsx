import { expect, it } from "vite-plus/test";
import "~/index.css";
import { render } from "../../test/render";
import { setLanguagePreference } from "../i18n";
import { CoxBrand } from "./CoxBrand";
import { UnreadCompletionIndicator } from "./sidebar/UnreadCompletionIndicator";

it("keeps the Cox name and logo without a translated Code suffix", async () => {
  setLanguagePreference("zh");
  try {
    await using screen = await render(<CoxBrand />, { router: false });
    await expect.element(screen.getByText("Cox", { exact: true })).toBeVisible();
    expect(screen.container.querySelector("img")?.getAttribute("src")).toBe("/cox.svg");
    expect(screen.container.textContent).toBe("Cox");
  } finally {
    setLanguagePreference("system");
  }
});

it("shows an explicit completed unread marker and removes it after reading", async () => {
  setLanguagePreference("zh");
  try {
    await using screen = await render(<UnreadCompletionIndicator visible />, { router: false });
    await expect.element(screen.getByRole("img", { name: "已完成，未读" })).toBeVisible();
    await screen.rerender(<UnreadCompletionIndicator visible={false} />);
    await expect.element(screen.getByRole("img", { name: "已完成，未读" })).not.toBeInTheDocument();
  } finally {
    setLanguagePreference("system");
  }
});
