export const stripSensitiveUrlToken = (url: URL): URL => {
  const next = new URL(url.toString());
  const hash = new URLSearchParams(next.hash.startsWith("#") ? next.hash.slice(1) : next.hash);
  if (hash.has("token")) {
    hash.delete("token");
    next.hash = hash.toString();
  }
  next.searchParams.delete("token");
  return next;
};
