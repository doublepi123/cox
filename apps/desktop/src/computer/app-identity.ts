import { execFile } from "node:child_process";
import { basename, join } from "node:path";
import type { ComputerAppIdentity } from "./executor.ts";

const output = (file: string, args: readonly string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(file, args, (error, stdout) => (error ? reject(error) : resolve(stdout))),
  );

async function readAppIdentity(pid: number): Promise<ComputerAppIdentity | null> {
  const executable = (await output("ps", ["-o", "comm=", "-p", String(pid)])).trim();
  const bundleEnd = executable.lastIndexOf(".app/");
  if (bundleEnd < 0) return null;
  const bundle = executable.slice(0, bundleEnd + 4);
  const bundleId = await output("plutil", [
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-o",
    "-",
    join(bundle, "Contents", "Info.plist"),
  ]).then(
    (value) => value.trim(),
    () => "",
  );
  return { bundleId: bundleId || null, name: basename(bundle, ".app") };
}

export function macAppIdentityResolver() {
  const identities = new Map<number, Promise<ComputerAppIdentity | null>>();
  return (pid: number) => {
    const known = identities.get(pid);
    if (known) return known;
    if (identities.size > 256) identities.clear();
    const identity = readAppIdentity(pid);
    identities.set(pid, identity);
    identity.catch(() => identities.delete(pid));
    return identity;
  };
}
