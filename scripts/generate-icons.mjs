import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const publicDirectory = new URL("../apps/web/public/", import.meta.url);
const source = await readFile(new URL("cox.svg", publicDirectory), "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:100%;height:100%}</style>${source}`,
  );
  for (const [size, filename] of [
    [16, "favicon-16x16.png"],
    [32, "favicon-32x32.png"],
    [180, "apple-touch-icon.png"],
    [192, "icon-192.png"],
    [512, "icon-512.png"],
  ]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({
      path: fileURLToPath(new URL(filename, publicDirectory)),
      omitBackground: true,
    });
  }
  await page.setViewportSize({ width: 256, height: 256 });
  const images = [
    await readFile(new URL("favicon-32x32.png", publicDirectory)),
    await page.screenshot({ omitBackground: true }),
  ];
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let imageOffset = header.length;
  for (const [index, image] of images.entries()) {
    const entryOffset = 6 + index * 16;
    const dimension = index === 0 ? 32 : 0;
    header[entryOffset] = dimension;
    header[entryOffset + 1] = dimension;
    header.writeUInt16LE(1, entryOffset + 4);
    header.writeUInt16LE(32, entryOffset + 6);
    header.writeUInt32LE(image.length, entryOffset + 8);
    header.writeUInt32LE(imageOffset, entryOffset + 12);
    imageOffset += image.length;
  }
  await writeFile(new URL("favicon.ico", publicDirectory), Buffer.concat([header, ...images]));
  console.log("Generated Cox PNG and ICO assets from public/cox.svg.");
} finally {
  await browser.close();
}
