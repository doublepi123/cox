import { ProviderDriverKind } from "@t3tools/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  ProviderInstanceIcon,
  resolveProviderInstanceAcpRegistryIconUrl,
} from "./ProviderInstanceIcon";

describe("ProviderInstanceIcon", () => {
  it.each(["OMO Native", "Custom agent", ""])(
    "renders the official OMO vector independently of the instance name %j",
    (displayName) => {
      const markup = renderToStaticMarkup(
        createElement(ProviderInstanceIcon, {
          driverKind: ProviderDriverKind.make("omo"),
          displayName,
          iconClassName: "size-4",
        }),
      );

      expect(markup).toContain('data-provider-icon="omo"');
      expect(markup).toContain('viewBox="0 0 1024 1024"');
      expect(markup).toContain('fill="currentColor"');
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain("size-4");
      expect(markup.match(/<path\b/g)).toHaveLength(2);
      expect(markup).not.toContain("text-3xs");
      expect(markup).not.toContain(">ON<");
      expect(markup).not.toMatch(/<(?:img|image|use)\b|(?:src|href)=|url\(/);
    },
  );

  it("keeps explicit instance badges separate from the OMO logo", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("omo"),
        displayName: "Work agent",
        accentColor: "#2563eb",
        showBadge: true,
      }),
    );

    expect(markup).toContain('data-provider-icon="omo"');
    expect(markup).toContain("--provider-accent:#2563eb");
    expect(markup).toContain(">WA</span>");
    expect(markup).not.toContain("text-3xs");
  });

  it("retains the package icon and unknown-provider fallback paths", () => {
    const packageMarkup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("pi"),
        displayName: "Pi",
      }),
    );
    const fallbackMarkup = renderToStaticMarkup(
      createElement(ProviderInstanceIcon, {
        driverKind: ProviderDriverKind.make("custom-agent"),
        displayName: "Custom agent",
      }),
    );

    expect(packageMarkup).toContain("data-provider-package-icon");
    expect(packageMarkup).not.toContain('data-provider-icon="omo"');
    expect(fallbackMarkup).toContain(">CA</span>");
    expect(fallbackMarkup).not.toContain("<svg");
  });
});

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});
