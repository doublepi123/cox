import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  "cocode/index.html",
  "cocode/styles.css",
  "cocode/main.js",
  "cocode/icon.png",
  "cocode/LICENSE",
  "cocode/NOTICE",
];

export async function buildPages(destination = join(root, "site/dist")) {
  await rm(destination, { recursive: true, force: true });
  for (const file of publicFiles) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, "site", file), target);
  }
  const versionedPath = async (file, directory = "") => {
    const content = await readFile(join(destination, directory, file));
    const version = createHash("sha256").update(content).digest("hex").slice(0, 16);
    return `${file}?v=${version}`;
  };
  const mainPath = join(destination, "main.js");
  const main = await readFile(mainPath, "utf8");
  await writeFile(
    mainPath,
    main.replace('"./content.js"', `"./${await versionedPath("content.js")}"`),
  );
  for (const directory of ["", "cocode"]) {
    const indexPath = join(destination, directory, "index.html");
    let html = await readFile(indexPath, "utf8");
    for (const file of ["styles.css", "main.js"]) {
      html = html.replace(`"${file}"`, `"${await versionedPath(file, directory)}"`);
    }
    await writeFile(indexPath, html);
  }
  await writeFile(join(destination, ".nojekyll"), "");
  console.log(`Cox website built: ${destination}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPages();
}
