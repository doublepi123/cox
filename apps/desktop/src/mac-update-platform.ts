import { execFile, spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  processIsAlive,
  type MacUpdateChild,
  type MacUpdateTransaction,
} from "./mac-update-transaction.ts";

const execute = promisify(execFile);

export async function macCommand(command: string, args: readonly string[]) {
  return execute("/usr/bin/" + command, [...args], {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function verifyMacApplication(
  application: string,
  expected: Pick<MacUpdateTransaction, "version" | "architecture" | "flavor" | "backendVersion"> &
    Partial<Pick<MacUpdateTransaction, "currentVersion">>,
  currentApplication?: string,
  command = macCommand,
) {
  const directory = await lstat(application);
  if (!directory.isDirectory() || directory.isSymbolicLink())
    throw new Error("The macOS update must contain a regular application bundle.");
  const info = JSON.parse(
    (
      await command("plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        join(application, "Contents/Info.plist"),
      ])
    ).stdout,
  ) as Record<string, unknown>;
  if (
    info.CFBundleIdentifier !== "dev.cox.desktop" ||
    info.CFBundleExecutable !== "Cox" ||
    info.CFBundleShortVersionString !== expected.version
  )
    throw new Error("The macOS application identity or version does not match the update.");
  const metadataPath = join(application, "Contents/Resources/backend.json");
  if ((await lstat(metadataPath)).size > 1024 * 1024)
    throw new Error("Invalid macOS update metadata.");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Record<string, unknown>;
  if (
    metadata.desktopVersion !== expected.version ||
    metadata.architecture !== expected.architecture ||
    metadata.platform !== "darwin" ||
    metadata.flavor !== expected.flavor ||
    metadata.coxVersion !== expected.backendVersion ||
    metadata.macUpdateProtocol !== 1 ||
    metadata.clientAutomaticUpdates !== true
  )
    throw new Error(
      "The macOS update does not match this client or support automatic replacement.",
    );
  const node = join(application, "Contents/Resources/runtime/bin/node");
  await command("codesign", ["--verify", "--deep", "--strict", application]);
  await command("codesign", ["--verify", "--strict", node]);
  for (const binary of [join(application, "Contents/MacOS/Cox"), node]) {
    const architectures = (await command("lipo", ["-archs", binary])).stdout.trim().split(/\s+/);
    if (!architectures.includes(expected.architecture === "arm64" ? "arm64" : "x86_64"))
      throw new Error("The macOS update has the wrong CPU architecture.");
  }
  const signature = await command("codesign", ["--display", "--verbose=4", application]);
  const description = signature.stdout + signature.stderr;
  const team = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(description)?.[1];
  if (!team && !/^Signature=adhoc$/m.test(description))
    throw new Error("The macOS update has no verifiable code signature.");
  if (currentApplication) {
    const currentInfo = JSON.parse(
      (
        await command("plutil", [
          "-convert",
          "json",
          "-o",
          "-",
          join(currentApplication, "Contents/Info.plist"),
        ])
      ).stdout,
    ) as Record<string, unknown>;
    if (
      currentInfo.CFBundleIdentifier !== "dev.cox.desktop" ||
      (expected.currentVersion &&
        currentInfo.CFBundleShortVersionString !== expected.currentVersion)
    )
      throw new Error("The installed Cox application changed during the update.");
    await command("codesign", ["--verify", "--deep", "--strict", currentApplication]);
    const current = await command("codesign", ["--display", "--verbose=4", currentApplication]);
    const currentTeam = /^TeamIdentifier=([A-Z0-9]{10})$/m.exec(
      current.stdout + current.stderr,
    )?.[1];
    if (currentTeam && currentTeam !== team)
      throw new Error("The macOS update changes the application's signing identity.");
  }
  if (team) await command("spctl", ["--assess", "--type", "execute", application]);
}

function launchEnvironment(home: string) {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !/^(?:COX_|T3CODE_|VITE_|ELECTRON_RUN_AS_NODE$|NODE_OPTIONS$|NODE_PATH$)/i.test(name),
      ),
    ),
    HOME: dirname(dirname(home)),
  };
}

export async function launchMacApplication(
  application: string,
  home: string,
  transaction?: MacUpdateTransaction,
  offline = false,
): Promise<MacUpdateChild> {
  const child = spawn(
    join(application, "Contents/MacOS/Cox"),
    [
      ...(transaction ? ["--cox-update-transaction=" + transaction.id] : []),
      ...(offline ? ["--offline"] : []),
    ],
    { detached: true, stdio: "ignore", env: launchEnvironment(home) },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  if (!child.pid) throw new Error("The updated Cox client could not start.");
  child.unref();
  const pid = child.pid;
  return {
    pid,
    exited: () => child.exitCode !== null || child.signalCode !== null,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        const deadline = performance.now() + 12_000;
        while (child.exitCode === null && child.signalCode === null && performance.now() < deadline)
          await delay(100);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        while (child.exitCode === null && child.signalCode === null) await delay(25);
      }
      let owner: unknown;
      try {
        owner = JSON.parse(await readFile(join(home, "backend-owner.json"), "utf8"));
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
          return;
        throw error;
      }
      if (
        !owner ||
        typeof owner !== "object" ||
        !("pid" in owner) ||
        typeof owner.pid !== "number" ||
        !Number.isSafeInteger(owner.pid) ||
        owner.pid < 1
      )
        throw new Error("Could not verify the updated client's backend owner.");
      if (!processIsAlive(owner.pid)) return;
      if (!("parentPid" in owner) || owner.parentPid !== pid)
        throw new Error(
          "A different Cox backend is still running; automatic data restoration was stopped.",
        );
      const deadline = performance.now() + 15_000;
      while (processIsAlive(owner.pid) && performance.now() < deadline) await delay(100);
      if (processIsAlive(owner.pid)) process.kill(-owner.pid, "SIGKILL");
      const stopped = performance.now() + 5_000;
      while (processIsAlive(owner.pid) && performance.now() < stopped) await delay(100);
      if (processIsAlive(owner.pid))
        throw new Error("The updated client's backend could not be stopped safely.");
    },
  };
}
