import { spawn } from "node:child_process";
import { open, stat } from "node:fs/promises";

const waitThenOpen = [
  "pid=$1; open=$2; application=$3; shift 3; attempts=0",
  'while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 600 ]; do sleep 0.1; attempts=$((attempts + 1)); done',
  'if kill -0 "$pid" 2>/dev/null; then echo "Cox relaunch: previous process did not exit" >&2; exit 1; fi',
  'if "$open" -n -a "$application" --args "$@"; then exit 0; fi',
  'echo "Cox relaunch: LaunchServices failed; retrying by bundle path" >&2',
  "sleep 1",
  'if "$open" -n "$application" --args "$@"; then exit 0; fi',
  'echo "Cox relaunch failed. Reopen Cox from Finder or the Dock." >&2',
  "exit 1",
].join("\n");

export function macRelaunchCommand(input: {
  readonly pid: number;
  readonly application: string;
  readonly args: readonly string[];
  readonly open?: string;
}) {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      waitThenOpen,
      "cox-relaunch",
      String(input.pid),
      input.open ?? "/usr/bin/open",
      input.application,
      ...input.args,
    ],
  };
}

export async function relaunchMacApplication(input: {
  readonly application: string;
  readonly args: readonly string[];
  readonly logPath: string;
}) {
  if (!(await stat(input.application)).isDirectory()) {
    throw new Error(`Invalid application bundle: ${input.application}`);
  }
  const { command, args } = macRelaunchCommand({ pid: process.pid, ...input });
  const log = await open(input.logPath, "a", 0o600);
  try {
    const child = spawn(command, args, { detached: true, stdio: ["ignore", "ignore", log.fd] });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
  } finally {
    await log.close();
  }
}
