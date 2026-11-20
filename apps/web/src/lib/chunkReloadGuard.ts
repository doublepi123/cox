// Deploys and desktop server swaps can invalidate lazy chunks; one reload fetches the fresh index.
const CHUNK_RELOAD_GUARD_KEY = "cox:chunk-load-reloaded";

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
  build = import.meta.env.APP_VERSION,
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    alreadyReloaded = storage.getItem(CHUNK_RELOAD_GUARD_KEY) === build;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, build);
  } catch {
    // Without storage, the reload guard cannot prevent an infinite loop.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}
