import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { codexAuthorizationRequest, codexCallbackUrl } from "./codexAuthHandoff.ts";

const authorizationUrl = () => {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:54213/auth/callback",
    state: "a".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "b".repeat(43),
  }).toString();
  return url.toString();
};
const input = {
  authorizationUrl: authorizationUrl(),
  returnUrl: "https://app.t3.codes/welcome#agents:remote-environment",
  environmentId: EnvironmentId.make("remote-environment"),
  instanceId: ProviderInstanceId.make("work-codex"),
  flowId: "flow-one",
};
const callbackUrl = `http://127.0.0.1:54213/auth/callback?state=${"a".repeat(43)}&code=one-time-code&client_id=oaiapp_test`;

describe("pasted Codex callback", () => {
  const { redirectUri, state } = codexAuthorizationRequest(input.authorizationUrl);
  const copied = callbackUrl.slice("http://".length);

  it("accepts a callback copied without its scheme", () => {
    expect(codexCallbackUrl(copied, redirectUri, state).toString()).toBe(callbackUrl);
  });
  it("accepts leading whitespace with or without a scheme", () => {
    expect(codexCallbackUrl(` \t\n${callbackUrl}`, redirectUri, state).toString()).toBe(
      callbackUrl,
    );
    expect(codexCallbackUrl(` \t\n${copied}`, redirectUri, state).toString()).toBe(callbackUrl);
  });
  it("still rejects a scheme-less callback for another address or sign-in", () => {
    expect(() =>
      codexCallbackUrl(copied.replace("127.0.0.1", "localhost"), redirectUri, state),
    ).toThrow();
    expect(() => codexCallbackUrl(copied.replace("54213", "54214"), redirectUri, state)).toThrow();
    expect(() => codexCallbackUrl(`${copied}&state=another`, redirectUri, state)).toThrow();
  });
});
