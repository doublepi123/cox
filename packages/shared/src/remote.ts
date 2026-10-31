const PAIRING_TOKEN_PARAM = "token";
const readHashParams = (url: URL): URLSearchParams =>
  new URLSearchParams(url.hash.startsWith("#") ? url.hash.slice(1) : url.hash);
export const getPairingTokenFromUrl = (url: URL): string | null => {
  const token =
    readHashParams(url).get(PAIRING_TOKEN_PARAM)?.trim() ||
    url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim();
  return token || null;
};
export const stripPairingTokenFromUrl = (url: URL): URL => {
  const next = new URL(url.toString());
  const hash = readHashParams(next);
  if (hash.has(PAIRING_TOKEN_PARAM)) {
    hash.delete(PAIRING_TOKEN_PARAM);
    next.hash = hash.toString();
  }
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  return next;
};
export const setPairingTokenOnUrl = (url: URL, credential: string): URL => {
  const next = new URL(url.toString());
  next.searchParams.delete(PAIRING_TOKEN_PARAM);
  next.hash = new URLSearchParams([[PAIRING_TOKEN_PARAM, credential]]).toString();
  return next;
};
