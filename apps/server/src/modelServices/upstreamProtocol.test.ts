import { ModelServiceConfig } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { modelServiceUpstreamProtocol } from "./upstreamProtocol.ts";

const service = Schema.decodeSync(ModelServiceConfig)({
  name: "Routing",
  baseUrl: "https://upstream.test",
  protocols: ["openai-chat", "openai-responses", "anthropic-messages", "gemini"],
});

describe("gateway upstream protocol", () => {
  it.each([
    ["gpt-6.1-terra", "openai-responses"],
    ["openai/GPT-6-astra", "openai-responses"],
    ["vendor/team/gpt-5", "openai-responses"],
    ["gpt", "openai-responses"],
    ["kimi-k2.8-code", "openai-chat"],
    ["kimi-k3.1-pro", "openai-chat"],
    ["moonshotai/Kimi-K3", "openai-chat"],
    ["kimi", "openai-chat"],
    ["gemini-3.8-flash", "anthropic-messages"],
    ["claude-fable", "anthropic-messages"],
    ["o3", "anthropic-messages"],
    ["not-gpt-5", "anthropic-messages"],
    ["gptish", "anthropic-messages"],
    ["not-kimi-k3", "anthropic-messages"],
    ["kimish", "anthropic-messages"],
  ] as const)("routes %s independently of client protocol and configured order", (id, expected) => {
    for (const incoming of service.protocols) {
      for (const protocols of [service.protocols, [...service.protocols].reverse()]) {
        expect(
          modelServiceUpstreamProtocol(
            { ...service, protocols: protocols as ModelServiceConfig["protocols"] },
            { id, name: "gpt display name", capabilities: null },
            incoming,
          ),
        ).toBe(expected);
      }
    }
  });

  it("preserves every single-protocol route and ignores duplicate protocol entries", () => {
    for (const protocol of service.protocols) {
      for (const incoming of service.protocols) {
        for (const id of ["gpt-6", "kimi-k2.8-code"]) {
          expect(
            modelServiceUpstreamProtocol(
              { ...service, protocols: [protocol, protocol] },
              { id, capabilities: null },
              incoming,
            ),
          ).toBe(protocol);
        }
      }
    }
  });

  it("never bypasses service or model protocol restrictions", () => {
    expect(
      modelServiceUpstreamProtocol(
        { ...service, protocols: ["openai-chat", "anthropic-messages"] },
        { id: "gpt-6", capabilities: null },
        "openai-chat",
      ),
    ).toBeUndefined();
    expect(
      modelServiceUpstreamProtocol(
        { ...service, protocols: ["anthropic-messages", "openai-responses"] },
        { id: "kimi-k3.1-pro", capabilities: null },
        "anthropic-messages",
      ),
    ).toBeUndefined();
    expect(
      modelServiceUpstreamProtocol(
        service,
        { id: "kimi-k2.8-code", capabilities: null, protocols: ["anthropic-messages"] },
        "anthropic-messages",
      ),
    ).toBeUndefined();
    expect(
      modelServiceUpstreamProtocol(
        service,
        { id: "claude-fable", capabilities: null, protocols: ["openai-chat"] },
        "openai-chat",
      ),
    ).toBeUndefined();
    expect(
      modelServiceUpstreamProtocol(
        service,
        { id: "gpt-6", capabilities: null, protocols: [] },
        "openai-responses",
      ),
    ).toBeUndefined();
  });
});
