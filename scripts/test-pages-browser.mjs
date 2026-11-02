import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildPages, publicFiles } from "./build-pages.mjs";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const contentTypes = {
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  svg: "image/svg+xml",
};

test("website works under a project subpath on desktop and phones without contacting an agent", async () => {
  const destination = await mkdtemp(join(tmpdir(), "cox-pages-browser-"));
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      const file = path === "/cox/" ? "index.html" : path.slice("/cox/".length);
      if (!path.startsWith("/cox/") || !publicFiles.includes(file)) {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("Content-Type", contentTypes[file.split(".").at(-1)]);
      response.end(await readFile(join(destination, file)));
    } catch {
      response.writeHead(404).end();
    }
  });
  let browser;
  try {
    await buildPages(destination);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      locale: "zh-CN",
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    await context.route("**/*", (route) =>
      route.request().url().startsWith(`${origin}/`) ? route.continue() : route.abort(),
    );
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value) => {
            window.copiedCommand = value;
          },
        },
      });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(`${origin}/cox/`);
    assert.equal(await page.locator("html").getAttribute("lang"), "zh-CN");
    const guide = page.locator("[data-i18n-href]");
    assert.match(await guide.getAttribute("href"), /\/README\.zh-CN\.md#/);
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    assert.equal(
      await page.getByRole("button", { name: "Claude", exact: true }).getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.locator("[data-demo]").getAttribute("data-agent"), "claude");
    assert.match(await page.locator("[data-agent-message]").textContent(), /拆分开/);
    await page.locator("[data-copy]").first().click();
    assert.equal(await page.evaluate(() => window.copiedCommand), "npx @doublepi123/cox@latest");
    assert.match(await page.getByRole("status").textContent(), /已复制/);
    assert.match(await page.locator("[data-copy]").first().getAttribute("class"), /is-copied/);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("denied");
          },
        },
      });
    });
    await page.locator("[data-copy]").first().click();
    assert.match(await page.getByRole("status").textContent(), /手动复制/);
    await page.getByRole("button", { name: "Switch to English" }).click();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    assert.match(await page.locator("h1").textContent(), /Your agents/);
    assert.match(await page.locator("[data-agent-message]").textContent(), /separate interface/);
    assert.equal(
      await guide.getAttribute("href"),
      "https://github.com/doublepi123/cox#quick-start-npm",
    );
    await page.reload();
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    for (const language of ["en", "zh"]) {
      if (
        (await page.locator("html").getAttribute("lang")) !== (language === "zh" ? "zh-CN" : "en")
      ) {
        await page.locator("[data-language-toggle]").click();
      }
      for (const width of [320, 390, 768, 1024, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(() => ({
          width: innerWidth,
          scroll: document.documentElement.scrollWidth,
          elements: [...document.querySelectorAll("body *")]
            .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
            .map((element) => element.className),
        }));
        assert.ok(
          overflow.scroll <= width,
          `${language} horizontal overflow: ${JSON.stringify(overflow)}`,
        );
        const tinyText = await page.evaluate(() =>
          [...document.querySelectorAll("body *")]
            .filter(
              (element) =>
                element.checkVisibility() &&
                [...element.childNodes].some(
                  (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim(),
                ) &&
                Number.parseFloat(getComputedStyle(element).fontSize) < 12,
            )
            .map((element) => `${element.tagName} ${element.textContent.trim().slice(0, 30)}`),
        );
        assert.deepEqual(tinyText, [], `${language} text below 12px at ${width}px`);
      }
      if (process.env.COX_PAGES_SCREENSHOTS) {
        await mkdir(process.env.COX_PAGES_SCREENSHOTS, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.screenshot({
          path: join(process.env.COX_PAGES_SCREENSHOTS, `desktop-${language}.png`),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: join(process.env.COX_PAGES_SCREENSHOTS, `mobile-${language}.png`),
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole("link", { name: "快速开始", exact: true }).click();
    assert.match(page.url(), /#start$/);
    assert.deepEqual(errors, []);
    await context.close();
    const noScript = await browser.newContext({ javaScriptEnabled: false });
    const staticPage = await noScript.newPage();
    await staticPage.goto(`${origin}/cox/`);
    assert.match(await staticPage.locator("h1").textContent(), /你的智能体/);
    assert.equal(
      await staticPage.getByRole("link", { name: "立即开始", exact: true }).getAttribute("href"),
      "#start",
    );
    await staticPage.goto(`${origin}/cox/cox/index.html`);
    await staticPage.waitForURL(`${origin}/cox/`);
    assert.match(await staticPage.locator("h1").textContent(), /你的智能体/);
    await noScript.close();
  } finally {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(destination, { recursive: true, force: true });
  }
});
