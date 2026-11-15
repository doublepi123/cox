import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = resolve(import.meta.dirname, "..");
const compiler = join(
  dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
  "bin/tsc",
);
const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-build-"));
const dist = join(directory, "dist");
try {
  execFileSync(process.execPath, [compiler, "-p", "tsconfig.build.json", "--outDir", temporary], {
    cwd: directory,
    stdio: "inherit",
  });
  await rm(dist, { recursive: true, force: true });
  for (const [sourceDirectory, outputDirectory] of [
    [join(temporary, "apps/desktop/src"), dist],
    [join(temporary, "packages/shared/src"), join(dist, "_shared")],
  ] as const) {
    for (const entry of await readdir(sourceDirectory, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const source = join(entry.parentPath, entry.name);
      const output = join(outputDirectory, relative(sourceDirectory, source));
      const contents = await readFile(source, "utf8");
      let emitted: string;
      if (entry.name.endsWith(".map")) {
        const map: { readonly sources: readonly string[] } = JSON.parse(contents);
        emitted = JSON.stringify({
          ...map,
          sources: map.sources.map((path) =>
            relative(dirname(output), resolve(dirname(source), path)).replaceAll("\\", "/"),
          ),
        });
      } else {
        emitted = contents.replaceAll(
          /(["'])@t3tools\/shared\/remoteServerAdmission\1/g,
          '"./_shared/remoteServerAdmission.js"',
        );
      }
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, emitted);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
