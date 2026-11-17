import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import type { SavedServerProfile, ServerDraft } from "../connections/store";
import { translator } from "../i18n";
import { ServerEditorSheet } from "./ServerEditorSheet";

const t = translator("en");
const httpProfile: SavedServerProfile = {
  id: "11111111-1111-4111-8111-111111111111",
  label: "LAN",
  origin: "http://127.0.0.1:3773",
  allowInsecureHttp: true,
  pinnedEnvironmentId: "env-mobile-a",
  lastServerVersion: "1.2.3",
  hasSavedPassword: false,
  lastThreadPath: null,
  lastConnectedAt: null,
  healthStatus: "unverified",
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

function renderEditor(profile: SavedServerProfile | null = null) {
  container = document.createElement("div");
  document.body.append(container);
  const mountedRoot = createRoot(container);
  root = mountedRoot;
  const onSave = vi.fn<(draft: ServerDraft) => Promise<void>>().mockResolvedValue(undefined);
  flushSync(() =>
    mountedRoot.render(
      <ServerEditorSheet
        profile={profile}
        initialOrigin="https://"
        onSave={onSave}
        onClose={() => {}}
        t={t}
      />,
    ),
  );
  return { onSave, permission: page.getByRole("checkbox", { name: t("allowHttp") }) };
}

afterEach(() => {
  flushSync(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("HTTP consent in the server editor", () => {
  it("collects a masked password only when vault saving is selected", async () => {
    const { onSave } = renderEditor();
    await page.getByLabelText(t("originLabel")).fill("https://cox.example.com");
    await expect.element(page.getByLabelText(t("vaultPassword"))).not.toBeInTheDocument();
    await page.getByRole("checkbox", { name: t("savePasswordInVault") }).click();
    const password = page.getByLabelText(t("vaultPassword"));
    await expect.element(password).toHaveAttribute("type", "password");
    await password.fill("secret-editor-password");

    await page.getByRole("button", { name: t("saveServer") }).click();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        password: "secret-editor-password",
        savePasswordInVault: true,
        requireBiometric: true,
      }),
    );
  });

  it("rejects HTTP before passing an unapproved draft to saving", async () => {
    const { onSave, permission } = renderEditor();
    await page.getByLabelText(t("originLabel")).fill(httpProfile.origin);

    await page.getByRole("button", { name: t("saveServer") }).click();

    await expect.element(permission).not.toBeChecked();
    await expect.element(page.getByRole("alert")).toHaveTextContent(t("httpOptInRequired"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows consent checked and saves HTTP after opting in", async () => {
    const { onSave, permission } = renderEditor();
    await page.getByLabelText(t("originLabel")).fill(httpProfile.origin);

    await expect.element(permission).toBeEnabled();
    await permission.click();

    await expect.element(permission).toBeChecked();
    await page.getByRole("button", { name: t("saveServer") }).click();
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ origin: httpProfile.origin, allowInsecureHttp: true }),
    );
  });

  it("allows consent before entering an HTTP origin", async () => {
    const { permission } = renderEditor();

    await permission.click();

    await expect.element(permission).toBeChecked();
  });

  it("shows saved HTTP consent and blocks saving after revocation", async () => {
    const { onSave, permission } = renderEditor(httpProfile);
    await expect.element(permission).toBeChecked();

    await permission.click();
    await page.getByRole("button", { name: t("saveServer") }).click();

    await expect.element(permission).not.toBeChecked();
    await expect.element(page.getByRole("alert")).toHaveTextContent(t("httpOptInRequired"));
    expect(onSave).not.toHaveBeenCalled();
  });

  it("clears permission in a saved HTTPS draft even when consent remains checked", async () => {
    const { onSave, permission } = renderEditor(httpProfile);
    await page.getByLabelText(t("originLabel")).fill("https://127.0.0.1:3773");
    await expect.element(permission).toBeChecked();

    await page.getByRole("button", { name: t("saveServer") }).click();

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "https://127.0.0.1:3773", allowInsecureHttp: false }),
    );
  });

  it("starts legacy HTTPS profiles with HTTP permission unchecked", async () => {
    const { permission } = renderEditor({ ...httpProfile, origin: "https://127.0.0.1:3773" });

    await expect.element(permission).not.toBeChecked();
    await expect.element(permission).toBeEnabled();
  });
});
