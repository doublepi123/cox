import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildPages, publicFiles } from "./build-pages.mjs";
import { messages, resolveLanguage } from "../site/content.js";

test("builds only the explicit public website files and removes stale artifacts", async () => {
  const destination = await mkdtemp(join(tmpdir(), "cox-pages-"));
  try {
    await writeFile(join(destination, "stale.txt"), "not public");
    await buildPages(destination);
    assert.deepEqual(
      (await readdir(destination, { recursive: true })).sort(),
      [".nojekyll", "assets", "cox", ...publicFiles].sort(),
    );
    assert.equal(await readFile(join(destination, ".nojekyll"), "utf8"), "");
    for (const file of publicFiles) {
      if (file === "index.html" || file === "main.js") continue;
      assert.deepEqual(
        await readFile(join(destination, file)),
        await readFile(new URL(`../site/${file}`, import.meta.url)),
      );
    }
    const versionedPath = async (file) => {
      const content = await readFile(join(destination, file));
      return `${file}?v=${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
    };
    const main = await readFile(new URL("../site/main.js", import.meta.url), "utf8");
    assert.equal(
      await readFile(join(destination, "main.js"), "utf8"),
      main.replace('"./content.js"', `"./${await versionedPath("content.js")}"`),
    );
    let html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
    for (const file of ["styles.css", "main.js"]) {
      html = html.replace(`"${file}"`, `"${await versionedPath(file)}"`);
    }
    assert.equal(await readFile(join(destination, "index.html"), "utf8"), html);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});

test("has complete bilingual content for every interface label", async () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort());
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  for (const [, key] of html.matchAll(/data-i18n(?:-aria|-href)?="([^"]+)"/g)) {
    for (const language of ["zh", "en"]) {
      assert.ok(messages[language][key]?.trim(), `${language}: ${key}`);
    }
  }
  for (const [, key, text] of html.matchAll(/data-i18n="([^"]+)"[^>]*>([^<]*)</g)) {
    assert.equal(text.trim().replace(/\s+/g, " "), messages.zh[key], `Chinese fallback: ${key}`);
  }
  for (const [tag, key] of html.matchAll(/<a\b[^>]*\bdata-i18n-href="([^"]+)"[^>]*>/g)) {
    assert.equal(tag.match(/\shref="([^"]+)"/)?.[1], messages.zh[key], `Chinese link: ${key}`);
  }
  for (const copy of Object.values(messages)) {
    assert.ok(
      Object.values(copy).every((value) => typeof value === "string" && value.trim().length > 0),
    );
  }
});

test("links desktop downloads to the rolling desktop release, not the server latest", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /class="desktop-downloads">\s*<a[^>]+href="https:\/\/github.com\/doublepi123\/cox\/releases\/tag\/cox-desktop-latest"/,
  );
});

test("works at a project Pages subpath without root-relative assets or a hosted backend", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.equal(/(?:href|src)="\/(?!\/)/.test(html), false);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.ok(html.includes("https://github.com/pingdotgg/t3code"));
  assert.ok(html.includes("npx @doublepi123/cox@latest"));
  const main = await readFile(new URL("../site/main.js", import.meta.url), "utf8");
  assert.equal(/\b(?:fetch|WebSocket|EventSource)\s*\(/.test(main), false);
  for (const [, href] of html.matchAll(/href="#([^"]+)"/g)) {
    assert.ok(html.includes(`id="${href}"`), `Missing anchor: ${href}`);
  }
});

test("draws icons with inline SVG instead of symbol glyphs that depend on font fallback", async () => {
  for (const file of ["index.html", "content.js"]) {
    const source = await readFile(new URL(`../site/${file}`, import.meta.url), "utf8");
    assert.deepEqual(source.match(/[\u2190-\u2bff\u{1f300}-\u{1faff}]/gu) ?? [], [], file);
  }
});

test("detects a supported language and respects a saved preference", () => {
  assert.equal(resolveLanguage("en", ["zh-CN"]), "en");
  assert.equal(resolveLanguage("zh", ["en-US"]), "zh");
  assert.equal(resolveLanguage(null, ["zh-TW"]), "zh");
  assert.equal(resolveLanguage("invalid", ["fr-FR", "en-GB", "zh-CN"]), "en");
  assert.equal(resolveLanguage(null, ["fr-FR"]), "en");
  assert.equal(resolveLanguage(null), "en");
});

test("links the full guide to an existing README section in each language", async () => {
  const slug = (heading) =>
    heading
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
      .replaceAll(" ", "-");
  for (const language of ["zh", "en"]) {
    const url = new URL(messages[language]["start.docsHref"]);
    const file = url.pathname.split("/blob/main/")[1] ?? "README.md";
    const readme = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    const anchors = [...readme.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => slug(heading));
    assert.ok(anchors.includes(decodeURIComponent(url.hash.slice(1))), `${language}: ${url}`);
  }
});

test("uses the account homepage and preserves the previously shared project address", async () => {
  const html = await readFile(new URL("../site/index.html", import.meta.url), "utf8");
  assert.ok(html.includes('rel="canonical" href="https://doublepi123.github.io/"'));
  assert.ok(
    html.includes('property="og:image" content="https://doublepi123.github.io/assets/social.png"'),
  );
  const redirect = await readFile(new URL("../site/cox/index.html", import.meta.url), "utf8");
  assert.ok(redirect.includes('http-equiv="refresh" content="0;url=../"'));
  assert.ok(redirect.includes('href="../"'));
});
