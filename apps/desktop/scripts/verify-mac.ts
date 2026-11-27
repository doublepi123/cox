import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAC_COMPUTER_ENGINE_BUILD, computerEngineFile } from "../src/computer/engine.ts";
import { assertInspectorFuseDisabled } from "./smoke-fuses.ts";

assert.equal(process.platform, "darwin", "macOS signature verification requires macOS.");
const flavor = process.env.COX_DESKTOP_CLIENT_ONLY === "true" ? "client-only" : "bundled";
const output = resolve(import.meta.dirname, "../../../release/desktop", flavor);
const metadata = JSON.parse(
  await readFile(join(output, "BUILD-" + flavor + "-darwin-" + process.arch + ".json"), "utf8"),
) as { artifactBaseName: string; computerEngineBuild: string };
assert.equal(metadata.computerEngineBuild, MAC_COMPUTER_ENGINE_BUILD);
const basename = metadata.artifactBaseName + "-mac-" + process.arch;
const temporary = await mkdtemp(join(tmpdir(), "cox-desktop-signatures-"));
const verify = (application: string) => {
  const localizations = JSON.parse(
    execFileSync(
      "plutil",
      [
        "-extract",
        "CFBundleLocalizations",
        "json",
        "-o",
        "-",
        join(application, "Contents/Info.plist"),
      ],
      { encoding: "utf8" },
    ),
  ) as string[];
  for (const locale of ["en", "zh-Hans", "zh-Hant"])
    assert.ok(localizations.includes(locale), "Application must declare localization " + locale);
  execFileSync("codesign", ["--verify", "--deep", "--strict", "--verbose=2", application], {
    stdio: "inherit",
  });
  const resources = join(application, "Contents/Resources");
  const engine = computerEngineFile("darwin");
  assert.ok(readdirSync(join(resources, "licenses", engine + "-NOTICES")).length > 0);
  const identity = spawnSync("codesign", ["--display", "--verbose=4", application], {
    encoding: "utf8",
  });
  assert.equal(identity.status, 0, identity.stderr);
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(identity.stderr)?.[1];
  assert.ok(team || /^Signature=adhoc$/m.test(identity.stderr), "Unknown application signature");
  for (const binary of ["runtime/bin/node", engine]) {
    execFileSync(
      "codesign",
      [
        "--verify",
        "--strict",
        "--verbose=2",
        ...(team
          ? ["-R", `=anchor apple generic and certificate leaf[subject.OU] = "${team}"`]
          : []),
        join(resources, binary),
      ],
      { stdio: "inherit" },
    );
  }
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
    await assertInspectorFuseDisabled(join(mounted, "Cox.app"));
  } finally {
    execFileSync("hdiutil", ["detach", mounted], { stdio: "inherit" });
  }
  console.log("PASS: unpacked and DMG signatures and disabled Node inspector fuse in the DMG.");
} finally {
  await rm(temporary, { recursive: true, force: true });
}
