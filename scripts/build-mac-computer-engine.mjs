import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { arch: { type: "string" }, output: { type: "string" }, archive: { type: "string" } },
});
if (
  process.platform !== "darwin" ||
  values.arch !== process.arch ||
  !["arm64", "x64"].includes(values.arch) ||
  !values.output
) {
  throw new Error(
    "Build the computer engine on the target Mac with --arch arm64|x64 and --output <path>.",
  );
}
const identity = process.env.COX_ENGINE_SIGN_IDENTITY || process.env.CSC_NAME || "-";
if (identity === "-" && process.env.CSC_LINK)
  throw new Error(
    "Import the Developer ID identity and set COX_ENGINE_SIGN_IDENTITY before building the signed engine.",
  );
const revision = "5835a98e88438f28a8ae0ee18039fad4d5fd415b";
const source = "https://github.com/code-yeongyu/oh-my-openagent";
const backport = "https://github.com/code-yeongyu/oh-my-openagent/pull/12720";
const patch = resolve(import.meta.dirname, "../patches/senpi-desktop-macos-focus.patch");
const output = resolve(values.output);
const notices = join(dirname(output), "senpi-desktop-engine-NOTICES");
const work = await mkdtemp(join(tmpdir(), "cox-mac-engine-"));
const target = (values.arch === "arm64" ? "aarch64" : "x86_64") + "-apple-darwin";
const prefix = "oh-my-openagent-" + revision;
const inputs = {
  "Cargo.lock": "d8e93b1a898d6418c0be40d1a9c4f00838d9af4f",
  "Cargo.toml": "48c84389f710832d7858ea50d68105cef4d8fe17",
  "LICENSE.md": "5982a8720a1cb87c26a36bb31d5019f119841769",
  "rust-toolchain.toml": "5a341ac1a9162977d296edcfabeaaa6726d43499",
  crates: "1abde229514c352155a0887724bdaeab160e1be4",
};
const env = {
  ...process.env,
  MACOSX_DEPLOYMENT_TARGET: "13.0",
  SENPI_DESKTOP_CAPTURE_HELPER_SIGNED: work,
};
const run = (cmd, args) => execFileSync(cmd, args, { cwd: work, env, stdio: "inherit" });
const text = (cmd, args) =>
  execFileSync(cmd, args, { cwd: work, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
try {
  const archive = values.archive ? resolve(values.archive) : join(work, "source.tgz");
  if (!values.archive)
    run("curl", [
      "-fsSL",
      "--retry",
      "3",
      "-o",
      archive,
      "https://codeload.github.com/code-yeongyu/oh-my-openagent/tar.gz/" + revision,
    ]);
  run("tar", [
    "-xzf",
    archive,
    "--strip-components=1",
    ...Object.keys(inputs).map((name) => prefix + "/" + name),
  ]);
  run("git", ["init", "-q"]);
  run("git", ["-c", "core.autocrlf=false", "add", "-f", "--", ...Object.keys(inputs)]);
  const tree = text("git", ["write-tree"]).trim();
  for (const [name, hash] of Object.entries(inputs)) {
    if (text("git", ["rev-parse", tree + ":" + name]).trim() !== hash)
      throw new Error("Upstream source verification failed: " + name);
  }
  run("git", ["apply", "--index", patch]);
  const binary = "senpi-desktop-engine";
  const helper = join(work, "senpi-desktop-capture-helper");
  run("/usr/bin/clang", [
    "-x",
    "objective-c",
    "-std=c11",
    "-fobjc-arc",
    "-O2",
    "-mmacosx-version-min=13.0",
    "-framework",
    "AppKit",
    "-framework",
    "ScreenCaptureKit",
    "-framework",
    "CoreVideo",
    "crates/senpi-desktop-backend-macos/native/senpi-desktop-capture-helper.m",
    "-o",
    helper,
  ]);
  const sign = (file, id) =>
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      ...(identity === "-" ? [] : ["--timestamp"]),
      "--identifier",
      id,
      file,
    ]);
  sign(helper, "dev.cox.desktop.capture-helper");
  run("cargo", [
    "test",
    "--release",
    "--locked",
    "--target",
    target,
    "-p",
    "senpi-desktop-backend-macos",
    "--lib",
    "rekey",
  ]);
  run("cargo", ["build", "--release", "--locked", "--target", target, "-p", binary]);
  await mkdir(dirname(output), { recursive: true });
  await cp(
    join(resolve(work, env.CARGO_TARGET_DIR || "target"), target, "release", binary),
    output,
  );
  sign(output, "dev.cox.desktop.computer-engine");
  run("/usr/bin/codesign", ["--verify", "--strict", output]);
  await mkdir(notices, { recursive: true });
  await cp(join(work, "LICENSE.md"), join(notices, "upstream-LICENSE.md"));
  const used = new Set(
    text("cargo", [
      "tree",
      "--locked",
      "-p",
      binary,
      "--target",
      target,
      "--edges",
      "normal,build",
      "--no-dedupe",
      "--prefix",
      "none",
      "--format",
      "{p}",
    ])
      .split("\n")
      .map((line) => line.split(" ").slice(0, 2).join(" ")),
  );
  const metadata = JSON.parse(
    text("cargo", ["metadata", "--locked", "--format-version", "1", "--filter-platform", target]),
  );
  const packages = [];
  for (const pkg of metadata.packages) {
    if (!used.has(pkg.name + " v" + pkg.version)) continue;
    const directory = dirname(pkg.manifest_path);
    const folder = pkg.name + "-" + pkg.version;
    const licenseFiles = (await readdir(directory)).filter((f) =>
      /^(licen[cs]e|licences|copying|notice|copyright)(?:[. _-]|$)/i.test(f),
    );
    if (pkg.license_file && !licenseFiles.includes(pkg.license_file))
      licenseFiles.push(pkg.license_file);
    for (const file of licenseFiles)
      await cp(resolve(directory, file), join(notices, folder, basename(file)), {
        recursive: true,
      });
    packages.push({
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      repository: pkg.repository,
      authors: pkg.authors,
    });
  }
  await writeFile(join(notices, "packages.json"), JSON.stringify(packages, null, 2) + "\n");
  await writeFile(
    join(notices, "README.txt"),
    "Cox builds this modified macOS engine from " +
      source +
      " at " +
      revision +
      " with the focus hand-back change from " +
      backport +
      " (f4dea74687f9214bd022ad2cebfea4eeb59288c9). The upstream Rust workspace declares MIT. See upstream-LICENSE.md, packages.json and the accompanying component notices.\n",
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
