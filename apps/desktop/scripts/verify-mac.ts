import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

assert.equal(process.platform, "darwin", "macOS signature verification requires macOS.");
const flavor = process.env.COX_DESKTOP_CLIENT_ONLY === "true" ? "client-only" : "bundled";
const output = resolve(import.meta.dirname, "../../../release/desktop", flavor);
const metadata = JSON.parse(
  await readFile(join(output, "BUILD-" + flavor + "-darwin-" + process.arch + ".json"), "utf8"),
) as { artifactBaseName: string };
const basename = metadata.artifactBaseName + "-mac-" + process.arch;
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
  console.log("PASS: unpacked and DMG application signatures and bundled Node signatures.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
