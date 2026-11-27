import { StrictMode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  installCustomTheme,
  invalidateCustomThemes,
  parseThemeFile,
  THEME_FILE_VERSION,
} from "../../themePalette";
import type { OpenVsxThemeExtension } from "../../openVsxThemes";
import { ThemeImportDialog } from "./ThemeImportDialog";

it.each(["paste", "batch"])("imports a VS Code JSONC theme via %s", async (source) => {
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  using _themes = {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
  await using _screen = await render(
    <ThemeImportDialog
      open
      onOpenChange={() => {}}
      onImported={() => true}
      onImportedMany={() => {}}
    />,
  );
  const jsonc = `{
    // An editor theme may contain comments and trailing commas.
    "name": "JSONC Night",
    "type": "dark",
    "colors": { "editor.background": "#002b36", },
  }`;
  if (source === "paste") {
    await page.getByRole("textbox", { name: "Theme JSON" }).fill(jsonc);
    await page.getByRole("button", { name: "Add theme", exact: true }).click();
  } else {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      new File([jsonc], "night.json", { type: "application/json" }),
      themeFile("Dawn"),
    ]);
  }
  await vi.waitFor(() => {
    expect(getCustomThemes().map((theme) => theme.label)).toEqual(
      source === "paste" ? ["JSONC Night"] : ["JSONC Night", "Dawn"],
    );
  });
});

const searchOpenVsxThemes = vi.hoisted(() => vi.fn());

vi.mock("../../openVsxThemes", () => ({
  searchOpenVsxThemes,
  importOpenVsxThemeExtension: vi.fn(),
}));

const extension: OpenVsxThemeExtension = {
  id: "acme.nightfall",
  collectionId: "acme.nightfall",
  name: "Nightfall",
  publisher: "acme",
  description: "A dark theme",
  downloadCount: 10,
  iconUrl: null,
  sourceUrl: null,
  manifestUrl: "https://example.test/manifest",
  sha256Url: "https://example.test/sha256",
  vsixUrl: "https://example.test/vsix",
  version: "1.0.0",
  license: "MIT",
};

describe("ThemeImportDialog", () => {
  // StrictMode replays ref attach/detach on mount, which must not end the session.
  it("searches Open VSX under StrictMode", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([extension]);
    await using _screen = await render(
      <StrictMode>
        <ThemeImportDialog
          open
          onOpenChange={() => {}}
          onImported={() => true}
          onImportedMany={() => {}}
        />
      </StrictMode>,
    );

    await userEvent.type(page.getByLabelText("Search Open VSX themes"), "night");

    await expect.element(page.getByRole("heading", { name: "Nightfall" })).toBeVisible();
    expect(searchOpenVsxThemes).toHaveBeenCalledWith(
      "night",
      expect.objectContaining({ sortBy: "downloadCount" }),
    );
  });

  it("clears the search on Escape before closing the dialog", async () => {
    searchOpenVsxThemes.mockReset();
    searchOpenVsxThemes.mockResolvedValue([]);
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const search = page.getByRole("searchbox", { name: "Search Open VSX themes" });
    await expect.element(search).toHaveAttribute("type", "text");
    await userEvent.fill(search, "nord");
    await userEvent.keyboard("{Escape}");
    await expect.element(search).toHaveValue("");
    search.element().dispatchEvent(
      new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Escape",
        repeat: true,
      }),
    );
    expect(onOpenChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

const theme = (name: string, accent = "#3b82f6") => ({
  version: THEME_FILE_VERSION,
  name,
  appearance: "dark",
  colors: { accent },
});

const themeFile = (name: string, accent?: string) =>
  new File([JSON.stringify(theme(name, accent))], `${name}.json`, { type: "application/json" });

it.each(["Update existing", "Keep both"])(
  "keeps batch failures visible after %s",
  async (choice) => {
    using _themes = {
      [Symbol.dispose]() {
        window.localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        invalidateCustomThemes();
      },
    };
    installCustomTheme(parseThemeFile(theme("Dusk")));
    const onOpenChange = vi.fn();
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={onOpenChange}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await userEvent.upload(input, [
      themeFile("Dawn"),
      themeFile("Dusk", "#f97316"),
      new File(["{"], "broken.json", { type: "application/json" }),
    ]);

    await expect.element(page.getByText("Already installed")).toBeVisible();
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(getCustomThemes().map((theme) => theme.label)).toContain("Dawn");
    await page.getByRole("button", { name: choice }).click();
    invalidateCustomThemes();
    const label = choice === "Update existing" ? "Dusk" : "Dusk (1)";
    expect(getCustomThemes().find((theme) => theme.label === label)?.colors).toEqual(
      parseThemeFile(theme("Dusk", "#f97316")).colors,
    );
    await expect.element(page.getByText(/^broken\.json:/)).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  },
);

it.each(["failed read", "batch install"])(
  "keeps the oversized replacement warning after a superseded %s",
  async (earlierImport) => {
    const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
    localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
    invalidateCustomThemes();
    using _themes = {
      [Symbol.dispose]() {
        if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
        else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
        invalidateCustomThemes();
      },
    };
    await using _screen = await render(
      <ThemeImportDialog
        open
        onOpenChange={() => {}}
        onImported={() => true}
        onImportedMany={() => {}}
      />,
    );
    let resolveRead!: (text: string) => void;
    let rejectRead!: (cause: Error) => void;
    const earlierRead = new Promise<string>((resolve, reject) => {
      resolveRead = resolve;
      rejectRead = reject;
    });
    let signalReadStarted!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    const earlierFile = Object.assign(themeFile("Dusk"), {
      text() {
        signalReadStarted();
        return earlierRead;
      },
    });
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = new DataTransfer();
    if (earlierImport === "batch install") files.items.add(themeFile("Dawn"));
    files.items.add(earlierFile);
    await act(async () => {
      input.files = files.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      await readStarted;
    });
    await expect.element(page.getByRole("button", { name: "Reading…" })).toBeDisabled();
    await userEvent.upload(
      input,
      new File([" ".repeat(256 * 1024 + 1)], earlierFile.name, { type: "application/json" }),
    );
    const warning = page.getByText(/^That file is/);
    await expect.element(warning).toBeVisible();

    await act(async () => {
      if (earlierImport === "batch install") {
        resolveRead(JSON.stringify(theme("Dusk")));
      } else {
        rejectRead(new Error("Could not read Dusk"));
      }
      await earlierRead.catch(() => {});
    });

    expect(getCustomThemes().map((theme) => theme.label)).toEqual([]);
    await expect.element(warning).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Choose files" })).toBeEnabled();
  },
);

it("names an oversized file in a batch import in the UI language", async () => {
  const previous = localStorage.getItem(CUSTOM_THEMES_STORAGE_KEY);
  localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
  invalidateCustomThemes();
  using _themes = {
    [Symbol.dispose]() {
      if (previous === null) localStorage.removeItem(CUSTOM_THEMES_STORAGE_KEY);
      else localStorage.setItem(CUSTOM_THEMES_STORAGE_KEY, previous);
      invalidateCustomThemes();
    },
  };
  setLanguagePreference("zh");
  using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
  await using _screen = await render(
    <ThemeImportDialog
      open
      onOpenChange={() => {}}
      onImported={() => true}
      onImportedMany={() => {}}
    />,
  );
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  await userEvent.upload(input, [
    themeFile("Dawn"),
    new File(["x".repeat(1_048_100)], "huge.json", { type: "application/json" }),
  ]);

  await expect
    .element(page.getByRole("alert"))
    .toHaveTextContent(
      "huge.json: 该文件大小为 1024 KB。主题文件通常仅为几 KB，因此未读取此文件（限制为 256 KB）。",
    );
});
