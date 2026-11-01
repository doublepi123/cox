import { readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, parsePatch, reversePatch } from "diff";

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const patches = JSON.parse(await readFile(join(root, "patches/manifest.json"), "utf8"));
for (const patch of patches) {
  const packageJson = require.resolve(`${patch.name}/package.json`);
  const installed = JSON.parse(await readFile(packageJson, "utf8"));
  if (installed.version !== patch.version) {
    throw new Error(
      `Cannot patch ${patch.name}: expected ${patch.version}, got ${installed.version}`,
    );
  }
  const packageRoot = await realpath(dirname(packageJson));
  const changes = parsePatch(await readFile(join(root, "patches", patch.file), "utf8"));
  const updates = [];
  for (const change of changes) {
    const filename = change.newFileName?.replace(/^b\//, "");
    if (!filename || isAbsolute(filename)) throw new Error("Invalid runtime patch path");
    const target = await realpath(resolve(packageRoot, filename));
    const relativePath = relative(packageRoot, target);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error("Runtime patch paths must stay inside the dependency");
    }
    const original = await readFile(target, "utf8");
    const patched = applyPatch(original, change);
    if (patched === false) {
      if (applyPatch(original, reversePatch(change)) !== false) continue;
      throw new Error(`Cannot apply ${patch.file} to ${filename}`);
    }
    updates.push({ target, patched });
  }
  for (const update of updates) await writeFile(update.target, update.patched);
}
