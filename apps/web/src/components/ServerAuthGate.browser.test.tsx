import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import {
  resolveInitialServerAuthGateState,
  submitServerAuthCredential,
} from "../environments/primary";
import { ServerAuthGate } from "./ServerAuthGate";

vi.mock("../environments/primary", () => ({
  submitServerAuthCredential: vi.fn(),
  resolveInitialServerAuthGateState: vi.fn(),
}));

const auth = {
  policy: "loopback-browser",
  loginMode: "password",
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "cox_session",
} as const;

describe("ServerAuthGate", () => {
  it("never asks local-mode users for a password", async () => {
    vi.mocked(submitServerAuthCredential).mockReset();
    vi.mocked(resolveInitialServerAuthGateState)
      .mockReset()
      .mockResolvedValue({ status: "authenticated" });
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={{ ...auth, loginMode: "local" }} onAuthenticated={onAuthenticated} />,
    );
    await expect.element(page.getByLabelText("Password", { exact: true })).not.toBeInTheDocument();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(resolveInitialServerAuthGateState).toHaveBeenCalledOnce();
    expect(submitServerAuthCredential).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("shows a usable login form and refreshes the current route after authentication", async () => {
    vi.mocked(submitServerAuthCredential).mockReset();
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={auth} onAuthenticated={onAuthenticated} />,
    );

    await expect.element(page.getByRole("heading", { name: "Sign in to Cox" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Sign in", exact: true })).toBeDisabled();
    await page.getByLabelText("Password", { exact: true }).fill("test-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    expect(submitServerAuthCredential).toHaveBeenCalledWith("test-password");
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("shows rejected credentials and allows a retry without opening the chat shell", async () => {
    vi.mocked(submitServerAuthCredential)
      .mockReset()
      .mockRejectedValueOnce(new Error("Invalid password"));
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={auth} onAuthenticated={onAuthenticated} />,
    );

    await page.getByLabelText("Password").fill("wrong-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Invalid password");
    expect(onAuthenticated).not.toHaveBeenCalled();

    await page.getByLabelText("Password").fill("correct-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(onAuthenticated).toHaveBeenCalledOnce();
  });

  it("displays initial authentication failures and prevents duplicate submissions", async () => {
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
        errorMessage="Invalid password"
        onAuthenticated={onAuthenticated}
      />,
    );

    await expect.element(page.getByRole("alert")).toHaveTextContent("Invalid password");
    await page.getByLabelText("Password", { exact: true }).fill("new-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Signing in…" })).toBeDisabled();
    expect(submitServerAuthCredential).toHaveBeenCalledOnce();
    finish?.();
    await expect.poll(() => onAuthenticated.mock.calls.length).toBe(1);
  });
});
