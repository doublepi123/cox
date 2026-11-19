// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { runLocalServiceCommand } from "./process.ts";
import { isBackendVersion } from "./release.ts";

export const LOCAL_SERVICE_UPDATE_ENV = "COX_LOCAL_SERVICE_UPDATE";
const DEFAULT_UNIT = "cox.service";
const HELPER_PREFIX = "cox-local-service-update-";

export interface LocalServiceUpdateOwnership {
  readonly serviceUnit: string;
  readonly node: string;
  readonly npm: string;
  readonly dropIn: string;
  readonly argsBeforeEntry: readonly string[];
  readonly argsAfterEntry: readonly string[];
}

export function stableVersion(value: unknown): value is string {
  return isBackendVersion(value);
}

export function compareVersions(left: string, right: string): number {
  if (!stableVersion(left) || !stableVersion(right)) throw new Error("Invalid Cox version.");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function isLocalServiceUpdateUnit(value: string): boolean {
  return (
    /^[a-z][a-z0-9_.@-]*\.service$/i.test(value) &&
    !value.includes("..") &&
    !value.startsWith(HELPER_PREFIX) &&
    value !== "cox-local-service-update.service"
  );
}

export function localServiceUpdateHelper(unit: string): string {
  return `${HELPER_PREFIX}${unit}`;
}

export function isNpmCoxInstallation(input: {
  readonly enabled: boolean;
  readonly desktop: boolean;
  readonly entryPath: string | undefined;
  readonly staticDir: string | undefined;
}): boolean {
  if (!input.enabled || input.desktop || !input.entryPath || !input.staticDir) return false;
  try {
    const entry = realpathSync(input.entryPath);
    const root = dirname(dirname(entry));
    if (
      entry !== join(root, "dist", "bin.mjs") ||
      realpathSync(input.staticDir) !== join(root, "dist", "client")
    )
      return false;
    const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return (
      typeof manifest === "object" &&
      manifest !== null &&
      "name" in manifest &&
      manifest.name === "@doublepi123/cox"
    );
  } catch {
    return false;
  }
}

export function supportsNpmCoxUpdates(config: {
  readonly devUrl: unknown;
  readonly staticDir: string | undefined;
}): boolean {
  return isNpmCoxInstallation({
    enabled: config.devUrl === undefined,
    desktop: process.send !== undefined,
    entryPath: process.argv[1],
    staticDir: config.staticDir,
  });
}

export async function assertLocalServiceMainPid(serviceUnit: string, pid: number): Promise<void> {
  const mainPid = await runLocalServiceCommand(
    "systemctl",
    ["--user", "show", "--property=MainPID", "--value", serviceUnit],
    { timeout: 5_000 },
  );
  if (mainPid.trim() !== String(pid))
    throw new Error("The configured systemd user service does not own this Cox process.");
}

export function localServiceDropIn(configHome: string, serviceUnit: string): string {
  return join(configHome, "systemd", "user", serviceUnit + ".d", "90-cox-update.conf");
}

export async function detectLocalServiceUpdateOwnership(): Promise<LocalServiceUpdateOwnership | null> {
  if (
    process.platform !== "linux" ||
    process.env[LOCAL_SERVICE_UPDATE_ENV] !== "1" ||
    !process.env.INVOCATION_ID ||
    !process.env.HOME
  )
    return null;
  const serviceUnit = process.env.COX_LOCAL_SERVICE_UPDATE_UNIT ?? DEFAULT_UNIT;
  if (!isLocalServiceUpdateUnit(serviceUnit)) return null;
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config");
  const node = process.execPath;
  const candidates = [
    resolve(node, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ...(process.env.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((directory) => join(directory, "npm")),
  ];
  const npm = candidates
    .map((candidate) => {
      try {
        return realpathSync(candidate);
      } catch {
        return null;
      }
    })
    .find((candidate) => candidate?.endsWith("/npm-cli.js"));
  if (!npm) return null;
  await assertLocalServiceMainPid(serviceUnit, process.pid);
  return {
    serviceUnit,
    node,
    npm,
    dropIn: localServiceDropIn(configHome, serviceUnit),
    argsBeforeEntry: process.execArgv,
    argsAfterEntry: process.argv.slice(2),
  };
}

export function updateEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|HOME|USER|LOGNAME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_[A-Z_]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|CC|CXX|AR|PYTHON)$/i;
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => allowed.test(name)));
}
