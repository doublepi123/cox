import { posix, win32 } from "node:path";
import { isLocalEditorFileUrl } from "@t3tools/contracts";

export function backendOriginFromOutput(output: string): string | undefined {
  const match = /Local URL:\s*(http:\/\/127\.0\.0\.1:(\d+))(?=\s|$)/.exec(output);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return undefined;
  return match[1];
}

export function isBackendNavigation(target: string, origin: string): boolean {
  try {
    const url = new URL(target);
    return url.origin === origin && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isExternalNavigation(target: string): boolean {
  try {
    const url = new URL(target);
    return (
      (["https:", "http:", "mailto:"].includes(url.protocol) || isLocalEditorFileUrl(url)) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function settingsWindowUrl(path: unknown, origin: string): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
    throw new Error("Invalid settings window path.");
  const url = new URL(path, origin);
  if (
    !isBackendNavigation(url.href, origin) ||
    (url.pathname !== "/settings" && !url.pathname.startsWith("/settings/"))
  )
    throw new Error("Invalid settings window path.");
  return url.href;
}

export function backendEnvironment(input: {
  readonly inherited: NodeJS.ProcessEnv;
  readonly runtimeDirectory: string;
  readonly homeDirectory: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
  readonly loginPath?: string;
}): NodeJS.ProcessEnv {
  const environment = { ...input.inherited };
  for (const name of Object.keys(environment)) {
    if (/^(?:COX_|T3CODE_|VITE_|ELECTRON_|NODE_OPTIONS$|NODE_PATH$)/i.test(name))
      delete environment[name];
  }
  const pathKey = Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  const separator = input.platform === "win32" ? ";" : ":";
  const { join } = input.platform === "win32" ? win32 : posix;
  const candidates = [
    input.runtimeDirectory,
    input.loginPath,
    environment[pathKey],
    join(input.userHome, ".local", "bin"),
    join(input.userHome, ".npm-global", "bin"),
    ...(input.platform === "darwin"
      ? ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]
      : []),
  ];
  environment[pathKey] = [
    ...new Set(candidates.flatMap((value) => value?.split(separator) ?? []).filter(Boolean)),
  ].join(separator);
  return {
    ...environment,
    COX_HOME: input.homeDirectory,
    T3CODE_HOST: "127.0.0.1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
    COX_TELEMETRY_ENABLED: "false",
    T3CODE_TELEMETRY_ENABLED: "false",
  };
}
