import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const publicDirectory = new URL("../apps/web/public/", import.meta.url);
const mobileRoot = join(repoRoot, "apps/mobile");
const androidRes = join(mobileRoot, "android/app/src/main/res");
const brand = "#111a16";
const brandRgb = [0x11, 0x1a, 0x16];
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <path d="M39 17a19 19 0 1 0 0 30" stroke="#eef8f1" stroke-width="8" stroke-linecap="square"/>
  <path d="m45 25 7 7-7 7" stroke="#b4f769" stroke-width="5" stroke-linecap="square" stroke-linejoin="miter"/>
</svg>`;

const densities = [
  ["mdpi", 1],
  ["hdpi", 1.5],
  ["xhdpi", 2],
  ["xxhdpi", 3],
  ["xxxhdpi", 4],
];

const androidSplashes = [
  ["drawable/splash.png", 480, 320],
  ["drawable-land-mdpi/splash.png", 480, 320],
  ["drawable-land-hdpi/splash.png", 800, 480],
  ["drawable-land-xhdpi/splash.png", 1280, 720],
  ["drawable-land-xxhdpi/splash.png", 1600, 960],
  ["drawable-land-xxxhdpi/splash.png", 1920, 1280],
  ["drawable-port-mdpi/splash.png", 320, 480],
  ["drawable-port-hdpi/splash.png", 480, 800],
  ["drawable-port-xhdpi/splash.png", 720, 1280],
  ["drawable-port-xxhdpi/splash.png", 960, 1600],
  ["drawable-port-xxxhdpi/splash.png", 1280, 1920],
];

const removedCapacitorVectors = [
  "drawable/ic_launcher_background.xml",
  "drawable-v24/ic_launcher_foreground.xml",
];

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}

function encodePng(width, height, rgba, opaque) {
  const channels = opaque ? 3 : 4;
  const raw = Buffer.alloc((width * channels + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0;
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const alpha = rgba[index + 3];
      const blend = (channel, background) =>
        alpha === 255
          ? rgba[index + channel]
          : Math.round((rgba[index + channel] * alpha + background * (255 - alpha)) / 255);
      raw[offset] = opaque ? blend(0, brandRgb[0]) : rgba[index];
      raw[offset + 1] = opaque ? blend(1, brandRgb[1]) : rgba[index + 1];
      raw[offset + 2] = opaque ? blend(2, brandRgb[2]) : rgba[index + 2];
      offset += 3;
      if (!opaque) {
        raw[offset] = alpha;
        offset += 1;
      }
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = opaque ? 2 : 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngHeader(buffer) {
  const signature = buffer.subarray(0, 8).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colorType: buffer[25],
  };
}

async function rasterize(page, { width, height, svg, mode }) {
  await page.setViewportSize({ width, height });
  await page.setContent("<!doctype html><style>html,body{margin:0}</style>");
  const encoded = await page.evaluate(
    async ({ width, height, svg, mode, brand }) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (mode === "splash") {
        context.fillStyle = brand;
        context.fillRect(0, 0, width, height);
      }
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = () => reject(new Error("Could not draw cox.svg"));
        image.src = url;
      });
      let dx = 0;
      let dy = 0;
      let size = Math.min(width, height);
      if (mode === "foreground") {
        size = Math.round((width * 66) / 108);
        dx = Math.round((width - size) / 2);
        dy = Math.round((height - size) / 2);
      } else if (mode === "splash") {
        size = Math.round(Math.min(width, height) * 0.22);
        dx = Math.round((width - size) / 2);
        dy = Math.round((height - size) / 2);
      }
      context.drawImage(image, dx, dy, size, mode === "fill" ? size : size);
      if (mode === "round") {
        context.globalCompositeOperation = "destination-in";
        context.beginPath();
        context.arc(width / 2, height / 2, width / 2, 0, Math.PI * 2);
        context.fill();
      }
      URL.revokeObjectURL(url);
      const pixels = canvas.getContext("2d").getImageData(0, 0, width, height).data;
      let binary = "";
      const step = 0x8000;
      for (let index = 0; index < pixels.length; index += step) {
        binary += String.fromCharCode(...pixels.subarray(index, index + step));
      }
      return btoa(binary);
    },
    { width, height, svg, mode, brand },
  );
  return Buffer.from(encoded, "base64");
}

async function writeRaster(page, path, options) {
  const rgba = await rasterize(page, options);
  await writeFile(path, encodePng(options.width, options.height, rgba, options.opaque === true));
}

async function generateWebIcons(page, source) {
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
}

async function generateMobileIcons(page, source) {
  for (const relativePath of removedCapacitorVectors) {
    await rm(join(androidRes, relativePath), { force: true });
  }
  await writeFile(
    join(androidRes, "values/ic_launcher_background.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${brand}</color>
</resources>
`,
  );
  for (const [density, scale] of densities) {
    const launcher = Math.round(48 * scale);
    const foreground = Math.round(108 * scale);
    const directory = join(androidRes, `mipmap-${density}`);
    await writeRaster(page, join(directory, "ic_launcher.png"), {
      width: launcher,
      height: launcher,
      svg: source,
      mode: "fill",
    });
    await writeRaster(page, join(directory, "ic_launcher_round.png"), {
      width: launcher,
      height: launcher,
      svg: source,
      mode: "round",
    });
    await writeRaster(page, join(directory, "ic_launcher_foreground.png"), {
      width: foreground,
      height: foreground,
      svg: mark,
      mode: "foreground",
    });
  }
  await writeRaster(
    page,
    join(mobileRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
    { width: 1024, height: 1024, svg: source, mode: "fill", opaque: true },
  );
  const splash = await rasterize(page, {
    width: 2732,
    height: 2732,
    svg: mark,
    mode: "splash",
  });
  const splashPng = encodePng(2732, 2732, splash, true);
  for (const name of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"]) {
    await writeFile(
      join(mobileRoot, "ios/App/App/Assets.xcassets/Splash.imageset", name),
      splashPng,
    );
  }
  for (const [relativePath, width, height] of androidSplashes) {
    await writeRaster(page, join(androidRes, relativePath), {
      width,
      height,
      svg: mark,
      mode: "splash",
      opaque: true,
    });
  }
}

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (entry.isFile() && /\.(png|xml)$/u.test(entry.name)) files.push(path);
  }
  return files;
}

async function checkMobileIcons() {
  const forbidden = new Set(
    JSON.parse(
      await readFile(new URL("./capacitor-default-icon-hashes.json", import.meta.url), "utf8"),
    ).sha256,
  );
  const failures = [];
  const roots = [
    androidRes,
    join(mobileRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset"),
    join(mobileRoot, "ios/App/App/Assets.xcassets/Splash.imageset"),
  ];
  for (const root of roots) {
    for (const path of await walk(root)) {
      const bytes = await readFile(path);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const label = relative(repoRoot, path);
      if (forbidden.has(hash)) {
        failures.push(`${label} is still a Capacitor placeholder icon`);
      }
      const text = bytes.toString("utf8");
      if (text.includes("#26A69A") || text.includes("M66.94,46.02")) {
        failures.push(`${label} still contains the Capacitor placeholder artwork`);
      }
    }
  }
  const background = await readFile(join(androidRes, "values/ic_launcher_background.xml"), "utf8");
  if (!/#111a16/iu.test(background)) {
    failures.push("Android adaptive icon background must be #111a16 from cox.svg");
  }
  if (/#ffffff/iu.test(background)) {
    failures.push("Android adaptive icon background is still the Capacitor white placeholder");
  }
  const icon = pngHeader(
    await readFile(
      join(mobileRoot, "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"),
    ),
  );
  if (icon?.width !== 1024 || icon.height !== 1024 || icon.colorType !== 2) {
    failures.push("iOS AppIcon must be an opaque 1024 RGB PNG with no alpha channel");
  }
  for (const [density, scale] of densities) {
    const launcher = Math.round(48 * scale);
    const foreground = Math.round(108 * scale);
    for (const [name, size] of [
      ["ic_launcher.png", launcher],
      ["ic_launcher_round.png", launcher],
      ["ic_launcher_foreground.png", foreground],
    ]) {
      const header = pngHeader(await readFile(join(androidRes, `mipmap-${density}`, name)));
      if (header?.width !== size || header.height !== size) {
        failures.push(`mipmap-${density}/${name} must be ${size}x${size}`);
      }
    }
  }
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log("Mobile icons match cox.svg and are not Capacitor placeholders.");
}

const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  await checkMobileIcons();
} else {
  const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
  const { chromium } = require("playwright-core");
  const source = await readFile(new URL("cox.svg", publicDirectory), "utf8");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await generateWebIcons(page, source);
    await generateMobileIcons(page, source);
    console.log("Generated Cox web and mobile icons from public/cox.svg.");
  } finally {
    await browser.close();
  }
  await checkMobileIcons();
}
