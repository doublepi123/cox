import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const directory = fileURLToPath(new URL("../native/protocol-bridge/", import.meta.url));
const go = process.env.COX_GO_BINARY || "go";
const output = join(directory, "dist");
mkdirSync(output, { recursive: true });
const targets = process.argv.includes("--all")
  ? ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64", "win32-arm64"]
  : [`${process.platform}-${process.arch}`];
for (const target of targets) {
  const [platform, architecture] = target.split("-");
  const name = `cox-protocol-bridge-${target}${platform === "win32" ? ".exe" : ""}`;
  execFileSync(
    go,
    ["build", "-mod=readonly", "-trimpath", "-ldflags=-s -w", "-o", join(output, name), "."],
    {
      cwd: directory,
      stdio: "inherit",
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: platform === "win32" ? "windows" : platform,
        GOARCH: architecture === "x64" ? "amd64" : architecture,
      },
    },
  );
}
const moduleLines = execFileSync(
  go,
  [
    "list",
    "-mod=readonly",
    "-deps",
    "-f",
    "{{if and .Module (not .Module.Main)}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
    ".",
  ],
  { cwd: directory, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);
const notices = new Map<string, string>();
const goroot = execFileSync(go, ["env", "GOROOT"], { encoding: "utf8" }).trim();
notices.set("Go standard library", readFileSync(join(goroot, "LICENSE"), "utf8"));
for (const line of moduleLines) {
  const [name, version, moduleDirectory] = line.split("\t");
  if (!name || !moduleDirectory || notices.has(`${name}@${version}`)) continue;
  const files = readdirSync(moduleDirectory, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && /^(?:LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(entry.name),
  );
  if (!files.length) throw new Error(`No license notice found for ${name}@${version}`);
  notices.set(
    `${name}@${version}`,
    files.map((entry) => readFileSync(join(moduleDirectory, entry.name), "utf8")).join("\n\n"),
  );
}
writeFileSync(
  join(output, "PROTOCOL_BRIDGE_NOTICES.txt"),
  [...notices]
    .map(([name, text]) => `${name}\n${"=".repeat(name.length)}\n\n${text.trim()}`)
    .join("\n\n\n") + "\n",
);
