import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import {
  resolveInitialServerAuthGateState,
  submitServerAuthCredential,
} from "../environments/primary";
import {
  PrimaryEnvironmentAuthSessionTimeoutError,
  PrimaryEnvironmentCredentialRejectedError,
  PrimaryEnvironmentCredentialRequiredError,
  PrimaryEnvironmentRequestError,
} from "../environments/primary/auth";
import { setLanguagePreference } from "../i18n";
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
  it("keeps failed local sign-in gated and allows retry", async () => {
    vi.mocked(submitServerAuthCredential).mockReset();
    vi.mocked(resolveInitialServerAuthGateState)
      .mockReset()
      .mockResolvedValueOnce({
        status: "requires-auth",
        auth,
        errorMessage: "Local sign-in unavailable",
      })
      .mockResolvedValueOnce({ status: "authenticated" });
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={{ ...auth, loginMode: "local" }} onAuthenticated={onAuthenticated} />,
    );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent("Local sign-in unavailable");
    expect(onAuthenticated).not.toHaveBeenCalled();
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(onAuthenticated).toHaveBeenCalledOnce();
    expect(submitServerAuthCredential).not.toHaveBeenCalled();
  });

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

  it.each([
    [
      new PrimaryEnvironmentCredentialRejectedError({ providedLength: 5, cause: null }),
      "密码无效，请检查后重试。",
    ],
    [new PrimaryEnvironmentCredentialRequiredError({ providedLength: 0 }), "输入密码以继续。"],
    [
      new PrimaryEnvironmentAuthSessionTimeoutError({ timeoutMs: 2_000, elapsedMs: 2_000 }),
      "等待登录会话建立超时。",
    ],
    [
      new PrimaryEnvironmentRequestError({
        operation: "create-browser-session",
        status: 503,
        cause: null,
      }),
      "主环境请求在 create-browser-session 阶段失败（HTTP 503）。",
    ],
    [new Error("Proxy refused the request"), "Proxy refused the request"],
  ])("shows sign-in failure %s in Chinese", async (failure, message) => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    vi.mocked(submitServerAuthCredential).mockReset().mockRejectedValueOnce(failure);
    const onAuthenticated = vi.fn(async () => {});
    await using _screen = await render(
      <ServerAuthGate auth={auth} onAuthenticated={onAuthenticated} />,
    );
    await page.getByLabelText("密码").fill("wrong-password");
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect.element(page.getByRole("alert")).toHaveTextContent(message);
    expect(onAuthenticated).not.toHaveBeenCalled();
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
