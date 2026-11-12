import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { generateThirdPartyLicenseManifest } from "../../../../scripts/lib/third-party-licenses";
import { OmoIcon } from "./OmoIcon";

describe("OmoIcon", () => {
  it("preserves the pinned official SVG geometry and transforms", () => {
    const markup = renderToStaticMarkup(<OmoIcon />);
    const pathHashes = Array.from(markup.matchAll(/<path\b[^>]*\bd="([^"]+)"/g), ([, d]) =>
      bytesToHex(sha256(utf8ToBytes(d!.replace(/\s+/g, " ").trim()))),
    );

    expect(pathHashes).toEqual([
      "271b82248cb60d7fceac7ae16f860695518af5a72d9cb6f32413b0a0a902a57e",
      "fee174de8ec1b0c63fb0f4c279b5f01e70d26191b44717abf6b590fd02a71526",
    ]);
    expect(markup).toContain('viewBox="0 0 1024 1024"');
    expect(markup).toContain('transform="scale(0.5)"');
    expect(markup).toContain(
      'transform="translate(0.000000,2048.000000) scale(0.050000,-0.050000)"',
    );
    expect(markup).toContain('fill-rule="evenodd"');
    expect(markup).toContain('class="fill-background"');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).toContain("modified by Cox");
    expect(markup).not.toMatch(/<(?:img|image|use|script|foreignObject)\b|(?:src|href)=|url\(/);
  });

  it("forwards sizing and accessibility props", () => {
    const markup = renderToStaticMarkup(
      <OmoIcon className="size-6" role="img" aria-label="OmO" aria-hidden={false} />,
    );

    expect(markup).toContain('class="size-6"');
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="OmO"');
    expect(markup).toContain('aria-hidden="false"');
  });

  it("ships the upstream logo license and modification notice in the web notices manifest", async () => {
    const manifest = await generateThirdPartyLicenseManifest({
      configFile: new URL("../../../../third-party-licenses.config.json", import.meta.url),
      packageManifests: [],
      bundleName: "web",
    });
    const notice = manifest.entries.find((entry) => entry.name === "OmO official icon");

    expect(notice).toMatchObject({
      bundles: ["web"],
      kind: "custom",
      license: "LicenseRef-SUL-1.0",
      version: "5.1.69",
      sourceUrl:
        "https://github.com/code-yeongyu/oh-my-openagent/blob/2c62d8b85d679e60b17b25dc722d89500fdcdedd/.github/assets/omo-icon-light.svg",
    });
    expect(notice?.noticeText).toContain("MODIFICATION NOTICE");
    expect(notice?.noticeText).toContain("not relicensed under Cox's");
    expect(notice?.noticeText).toContain("free of charge for\nnon-commercial purposes");
    const license = notice!.noticeText.slice(notice!.noticeText.indexOf("# License")).trim();
    expect(bytesToHex(sha256(utf8ToBytes(`${license}\n`)))).toBe(
      "b61ac928f152d13517328263e6bee9175b928f9ab696a2d2ca2b6cfd961ddc32",
    );
  });
});
