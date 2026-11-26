import { isWindowsDrivePath } from "./path.ts";

export type CloneProtocol = "ssh" | "https";

const SCP_LIKE_URL = /^(?:[^@/\s]+@)?(\[[^\]@/\s]+\]|[^:/\s[\]]+):(?!\/)(.+)$/;
const SSH_URL = /^ssh:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;
const HTTPS_URL = /^https?:\/\/(?:[^/\s]*@)?(\[[^\]@/\s]+\]|[^@:/\s]+)(:\d+)?\/(.+)$/;

function parseCloneUrl(
  url: string,
): { protocol: CloneProtocol; host: string; path: string; customPort: boolean } | null {
  const trimmed = url.trim();
  const ssh = SSH_URL.exec(trimmed);
  if (ssh) return { protocol: "ssh", host: ssh[1]!, path: ssh[3]!, customPort: !!ssh[2] };
  const https = HTTPS_URL.exec(trimmed);
  if (https) return { protocol: "https", host: https[1]!, path: https[3]!, customPort: !!https[2] };
  const scp = SCP_LIKE_URL.exec(trimmed);
  if (scp) return { protocol: "ssh", host: scp[1]!, path: scp[2]!, customPort: false };
  return null;
}

/**
 * Drops what an HTTP(S) remote can carry as a login: userinfo and the query. SSH URLs keep
 * their user, which is part of the address.
 */
export function withoutRemoteUrlCredentials(url: string): string {
  if (!/^https?:\/\//i.test(url)) return url;
  return url.replace(/^(https?:\/\/)[^/?#]*@/i, "$1").replace(/\?[^#]*/, "");
}

export function isScpLikeCloneUrl(url: string): boolean {
  return SCP_LIKE_URL.test(url);
}

export function cloneUrlProtocol(url: string): CloneProtocol | null {
  return parseCloneUrl(url)?.protocol ?? null;
}

/**
 * Rewrites a clone URL to the other protocol, because the target machine may
 * only have SSH keys or only an HTTPS credential helper. Returns null when the
 * URL cannot be rewritten safely, such as a custom port.
 */
export function cloneUrlForProtocol(url: string, protocol: CloneProtocol): string | null {
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  if (parsed.protocol === protocol) return url.trim();
  if (parsed.customPort) return null;
  try {
    if (protocol === "ssh") {
      if (/[?#]/u.test(parsed.path)) return null;
      const path = decodeURIComponent(parsed.path);
      if (/\p{Cc}/u.test(path)) return null;
      return `git@${parsed.host}:${path}`;
    }
    const path = isScpLikeCloneUrl(url.trim())
      ? parsed.path.split("/").map(encodeURIComponent).join("/")
      : parsed.path;
    return `https://${parsed.host}/${path}`;
  } catch {
    return null;
  }
}

const UNSAFE_SEGMENT = /^\.{1,2}$|[\\:*?"<>|\p{Cc}]|[ .]$/u;
const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?: *\.| *$)/i;

export function cloneUrlRepositoryPath(url: string): string | null {
  if (isWindowsDrivePath(url.trim())) return null;
  const parsed = parseCloneUrl(url);
  if (!parsed) return null;
  let repositoryPath = parsed.path.split(isScpLikeCloneUrl(url.trim()) ? "?" : /[?#]/, 1)[0]!;
  if (SSH_URL.test(url.trim()) || HTTPS_URL.test(url.trim())) {
    try {
      repositoryPath = decodeURIComponent(repositoryPath);
    } catch {
      return null;
    }
  }
  const segments = [parsed.host, ...repositoryPath.split("/").filter(Boolean)];
  const last = segments.at(-1)!;
  if (last.endsWith(".git")) segments[segments.length - 1] = last.slice(0, -".git".length);
  if (
    segments.length < 2 ||
    segments.some(
      (segment) =>
        segment === "" || UNSAFE_SEGMENT.test(segment) || WINDOWS_DEVICE_NAME.test(segment),
    )
  )
    return null;
  return segments.join("/");
}
