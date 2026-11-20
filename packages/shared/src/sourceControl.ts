const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;
const USERLESS_SCP_SSH_REMOTE_PATTERN = /^[^@:/\\\s]{2,}:(?!:)\/?[^/\s]+(?:\/[^/\s]+)*\/?$/u;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return (
    SCP_SSH_REMOTE_PATTERN.test(trimmed) ||
    USERLESS_SCP_SSH_REMOTE_PATTERN.test(trimmed) ||
    trimmed.toLowerCase().startsWith("ssh://")
  );
}
