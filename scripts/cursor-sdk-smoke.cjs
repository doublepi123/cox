const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const directory = mkdtempSync(join(tmpdir(), "cox-cursor-smoke-"));
const previousDirectory = process.cwd();
const deadline = setTimeout(() => {
  console.error("Cursor SDK smoke test timed out");
  process.exit(1);
}, 60000);

process.env.HOME = directory;
process.env.XDG_CONFIG_HOME = join(directory, "config");
process.env.XDG_DATA_HOME = join(directory, "data");
process.env.XDG_CACHE_HOME = join(directory, "cache");
process.env.XDG_STATE_HOME = join(directory, "state");
process.chdir(directory);

async function main() {
  const { createAgentPlatform } = require("@cursor/sdk");
  for (const enabled of [true, false, true]) {
    const platform = await createAgentPlatform({ workspaceRef: directory });
    const release = await platform.prewarmLocalWorkspace({
      local: { cwd: directory, settingSources: [], sandboxOptions: { enabled } },
    });
    await release();
    console.log(`Cursor SDK prewarm ok (sandbox=${enabled})`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    clearTimeout(deadline);
    process.chdir(previousDirectory);
    rmSync(directory, { recursive: true, force: true });
  });
