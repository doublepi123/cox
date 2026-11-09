// @effect-diagnostics nodeBuiltinImport:off
import { dirname, resolve } from "node:path";
import { isBackendVersion } from "./release.ts";

export const LOCAL_SERVICE_UPDATE_ENV = "COX_LOCAL_SERVICE_UPDATE";
export const LOCAL_SERVICE_UPDATE_UNIT = "cox.service";
export const LOCAL_SERVICE_UPDATE_HELPER = "cox-local-service-update.service";

export interface LocalServiceUpdateOwnership {
  readonly serviceUnit: string;
  readonly node: string;
  readonly npm: string;
  readonly packageRoot: string;
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

export function localServiceUpdateUnit(value: string): string {
  if (
    !/^[a-z][a-z0-9_.@-]*\.service$/i.test(value) ||
    value.includes("..") ||
    value === LOCAL_SERVICE_UPDATE_HELPER
  )
    throw new Error("The Cox update service unit is invalid.");
  return value;
}

export function detectLocalServiceUpdateOwnership(input: {
  readonly enabled: boolean;
  readonly environment?: string;
  readonly platform: string;
  readonly execPath: string;
  readonly entryPath?: string;
  readonly staticDir?: string;
  readonly invocationId?: string;
  readonly realpath?: (path: string) => string;
}): LocalServiceUpdateOwnership | null {
  if (
    !input.enabled ||
    input.environment !== "1" ||
    input.platform !== "linux" ||
    !input.invocationId ||
    !input.entryPath ||
    !input.staticDir
  )
    return null;
  const entry = resolve(input.entryPath);
  if (!entry.endsWith("/dist/bin.mjs")) return null;
  const packageRoot = dirname(dirname(entry));
  if (resolve(input.staticDir) !== resolve(packageRoot, "dist", "client")) return null;
  const realpath = input.realpath ?? ((path: string) => path);
  const node = realpath(input.execPath);
  const npm = resolve(node, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
  return {
    serviceUnit: localServiceUpdateUnit(LOCAL_SERVICE_UPDATE_UNIT),
    node,
    npm,
    packageRoot,
  };
}

export function updateEnvironment(inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed =
    /^(?:PATH|HOME|USER|LOGNAME|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|LANG|LC_[A-Z_]+|TZ|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|CC|CXX|AR|PYTHON)$/i;
  return Object.fromEntries(Object.entries(inherited).filter(([name]) => allowed.test(name)));
}
