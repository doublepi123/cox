import { describe, expect, it } from "@effect/vitest";
import { CodexSettings } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Schema from "effect/Schema";
import { codexGatewayRuntime, gatewayBaseUrl } from "./gatewayConfiguration.ts";

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

describe("gateway configuration", () => {
  it("lets the model service own HTTP retries without changing direct gateway launches", () => {
    const config = decodeCodexSettings({
      baseUrl: "http://127.0.0.1/api/model-gateway/v1",
      apiKey: "local-token",
    });
    expect(
      tokenizeCliArgs(
        codexGatewayRuntime(config, { COX_MODEL_SERVICE_KEY: "local-token" }).settings.launchArgs,
      ),
    ).toEqual(
      expect.arrayContaining([
        "model_providers.cox_gateway.request_max_retries=0",
        "model_providers.cox_gateway.stream_max_retries=0",
      ]),
    );
    expect(codexGatewayRuntime(config, {}).settings.launchArgs).not.toMatch(/_max_retries/);
  });
  it("keeps subscription launches unchanged without API settings", () => {
    const config = decodeCodexSettings({});
    const environment = { OPENAI_API_KEY: "ambient" };
    expect(codexGatewayRuntime(config, environment)).toEqual({ settings: config, environment });
  });
  it("routes Codex through Responses without putting keys in launch arguments", () => {
    const config = decodeCodexSettings({
      baseUrl: "https://gateway.test/api/v1/",
      apiKey: "secret-test-key",
      launchArgs: "--enable feature",
    });
    const runtime = codexGatewayRuntime(config, { T3CODE_CODEX_LAUNCH_ARGS: "--disable old" });
    const args = tokenizeCliArgs(runtime.settings.launchArgs);
    expect(args).toContain('model_providers.cox_gateway.base_url="https://gateway.test/api/v1"');
    expect(args).toContain('model_providers.cox_gateway.wire_api="responses"');
    expect(args).toContain('model_providers.cox_gateway.env_key="COX_CODEX_API_KEY"');
    expect(runtime.settings.launchArgs).not.toContain("secret-test-key");
    expect(runtime.environment.COX_CODEX_API_KEY).toBe("secret-test-key");
    expect(args.slice(0, 2)).toEqual(["--disable", "old"]);
  });
  it("rejects URLs with embedded credentials or non-HTTP protocols", () => {
    for (const url of [
      "file:///tmp/models",
      "https://user:password@example.test",
      "https://example.test?key=secret",
      "https://example.test/#fragment",
    ]) {
      expect(() => gatewayBaseUrl(url, "")).toThrow();
      expect(() => decodeCodexSettings({ baseUrl: url })).toThrow();
    }
    expect(gatewayBaseUrl("http://127.0.0.1:8080/v1/", "")).toBe("http://127.0.0.1:8080/v1");
  });
});
