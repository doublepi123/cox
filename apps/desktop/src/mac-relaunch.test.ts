import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { macRelaunchCommand, relaunchMacApplication } from "./mac-relaunch.ts";

const directories: string[] = [];
const run = promisify(execFile);

it.skipIf(process.platform === "win32")(
  "retries a failed open by bundle path and reports a second failure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-relaunch-retry-"));
    directories.push(directory);
    const open = join(directory, "open");
    const { command, args } = macRelaunchCommand({
      pid: 2147483647,
      application: "/tmp/Cox QA.app",
      args: ["two words"],
      open,
    });
    await writeFile(
      open,
      '#!/bin/sh\n[ "$1" = -n ] && [ "$2" = "/tmp/Cox QA.app" ] && [ "$3" = --args ] && [ "$4" = "two words" ]\n',
      { mode: 0o700 },
    );
    expect((await run(command, args)).stderr).toContain("retrying by bundle path");
    await writeFile(open, "#!/bin/sh\nexit 1\n");
    await expect(run(command, args)).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Reopen Cox"),
    });
    await expect(
      relaunchMacApplication({
        application: join(directory, "missing.app"),
        args: [],
        logPath: join(directory, "desktop.log"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "opens the app through LaunchServices only after the quitting process exits",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cox-mac-relaunch-"));
    directories.push(directory);
    const record = join(directory, "open.txt");
    const fakeOpen = join(directory, "open");
    await writeFile(
      fakeOpen,
      `#!/bin/sh\nif kill -0 "$COX_QUITTING_PID" 2>/dev/null; then echo alive >> "${record}"; fi\nfor argument in "$@"; do printf '%s\\n' "$argument" >> "${record}"; done\n`,
      { mode: 0o755 },
    );
    const quitting = spawn(process.execPath, ["-e", "setTimeout(() => {}, 400)"], {
      stdio: "ignore",
    });
    const command = macRelaunchCommand({
      pid: quitting.pid!,
      application: "/Applications/Cox.app",
      args: ["--offline", "two words"],
      open: fakeOpen,
    });
    const relauncher = spawn(command.command, command.args, {
      stdio: "ignore",
      env: { ...process.env, COX_QUITTING_PID: String(quitting.pid) },
    });
    const exitCode = await new Promise<number | null>((resolve) =>
      relauncher.once("exit", resolve),
    );
    expect(exitCode).toBe(0);
    expect(quitting.exitCode).toBe(0);
    expect((await readFile(record, "utf8")).split("\n").filter(Boolean)).toEqual([
      "-n",
      "-a",
      "/Applications/Cox.app",
      "--args",
      "--offline",
      "two words",
    ]);
  },
);
