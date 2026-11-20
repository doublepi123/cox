import { win32 } from "node:path";

export function processTreeKillPlan(input: {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
}):
  | { readonly kind: "taskkill"; readonly command: string; readonly args: readonly string[] }
  | { readonly kind: "group"; readonly signal: NodeJS.Signals } {
  if (!Number.isInteger(input.pid) || input.pid <= 0)
    throw new Error("A process id is required to stop an owned process tree.");
  if (input.platform === "win32")
    return {
      kind: "taskkill",
      command: "taskkill.exe",
      args: ["/PID", String(input.pid), "/T", "/F"],
    };
  return { kind: "group", signal: "SIGKILL" };
}

export async function killOwnedProcessTree(input: {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly systemRoot?: string;
  readonly execFile: (file: string, args: readonly string[]) => Promise<void>;
  readonly killGroup: (pid: number, signal: NodeJS.Signals) => void;
}): Promise<void> {
  const plan = processTreeKillPlan(input);
  if (plan.kind === "taskkill") {
    await input.execFile(
      win32.join(input.systemRoot ?? "C:\\Windows", "System32", plan.command),
      plan.args,
    );
    return;
  }
  input.killGroup(input.pid, plan.signal);
}

export async function stopOwnedProcess(input: {
  readonly pid: number | undefined;
  readonly exited: () => boolean;
  readonly notify: () => void;
  readonly waitForExit: (timeoutMs: number) => Promise<boolean>;
  readonly timeoutMs: number;
  readonly force: () => Promise<void>;
}): Promise<"idle" | "graceful" | "forced"> {
  if (input.pid === undefined || input.exited()) return "idle";
  input.notify();
  if (input.exited()) return "graceful";
  if ((await input.waitForExit(input.timeoutMs)) || input.exited()) return "graceful";
  await input.force();
  return "forced";
}
