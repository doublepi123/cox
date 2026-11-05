import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "darwin", "macOS signature verification requires macOS.");
const output = resolve(import.meta.dirname, "../../../release/desktop");
const manifest = JSON.parse(
  await readFile(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as { version: string };
const basename = `Cox-${manifest.version}-mac-${process.arch}`;
const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-signatures-"));
const verify = (application: string) => {
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], {
    stdio: "inherit",
  });
  execFileSync(
    "codesign",
    [
      "--verify",
      "--strict",
      "--verbose=2",
      join(application, "Contents/Resources/runtime/bin/node"),
    ],
    { stdio: "inherit" },
  );
};

try {
  verify(join(output, process.arch === "arm64" ? "mac-arm64" : "mac", "Cox.app"));
  const extracted = join(temporary, "zip");
  await mkdir(extracted);
  execFileSync("ditto", ["-x", "-k", join(output, `${basename}.zip`), extracted], {
    stdio: "inherit",
  });
  verify(join(extracted, "Cox.app"));
  const mounted = join(temporary, "dmg");
  await mkdir(mounted);
  execFileSync(
    "hdiutil",
    ["attach", "-readonly", "-nobrowse", "-mountpoint", mounted, join(output, `${basename}.dmg`)],
    { stdio: "inherit" },
  );
  try {
    assert.ok((await readdir(mounted)).includes("Cox.app"), "DMG must contain Cox.app.");
    verify(join(mounted, "Cox.app"));
  } finally {
    execFileSync("hdiutil", ["detach", mounted], { stdio: "inherit" });
  }
  console.log("PASS: unpacked, ZIP and DMG application signatures and bundled Node signatures.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
