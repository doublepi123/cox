import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const publicFiles = [
  "index.html",
  "styles.css",
  "main.js",
  "content.js",
  "assets/cox.svg",
  "assets/social.png",
  "cox/index.html",
];

export async function buildPages(destination = join(root, "site/dist")) {
  await rm(destination, { recursive: true, force: true });
  for (const file of publicFiles) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, "site", file), target);
  }
  await writeFile(join(destination, ".nojekyll"), "");
  console.log(`Cox website built: ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPages();
}
