import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { submitServerAuthCredential } from "../environments/primary";
import { ServerAuthGate } from "./ServerAuthGate";

vi.mock("../environments/primary", () => ({ submitServerAuthCredential: vi.fn() }));

const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "cox_session",
} as const;

describe("ServerAuthGate", () => {
  it("shows a usable login form and refreshes the current route after authentication", async () => {
    vi.mocked(submitServerAuthCredential).mockReset();
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={auth} onAuthenticated={onAuthenticated} />,
    );

    await expect.element(page.getByRole("heading", { name: "Sign in to Cox" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await page.getByLabelText("Pairing token", { exact: true }).fill("test-pairing-token");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    expect(submitServerAuthCredential).toHaveBeenCalledWith("test-pairing-token");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("shows rejected credentials and allows a retry without opening the chat shell", async () => {
    vi.mocked(submitServerAuthCredential)
      .mockReset()
      .mockRejectedValueOnce(new Error("Invalid pairing token"));
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={{ ...auth, passwordLogin: true }} onAuthenticated={onAuthenticated} />,
    );

    await page.getByLabelText("Password or pairing token").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Invalid pairing token");
    expect(onAuthenticated).not.toHaveBeenCalled();

    await page.getByLabelText("Password or pairing token").fill("correct-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("displays URL pairing failures and prevents duplicate submissions", async () => {
    let finish: (() => void) | undefined;
    vi.mocked(submitServerAuthCredential)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate
        auth={auth}
        errorMessage="Expired pairing token"
        onAuthenticated={onAuthenticated}
      />,
    );

    await expect.element(page.getByRole("alert")).toHaveTextContent("Expired pairing token");
    await page.getByLabelText("Pairing token", { exact: true }).fill("new-token");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(submitServerAuthCredential).toHaveBeenCalledOnce();
    finish?.();
    await expect.poll(() => onAuthenticated.mock.calls.length).toBe(1);
  });
});
