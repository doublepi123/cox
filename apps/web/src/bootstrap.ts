import { showBootError } from "./lib/bootError";
import { chunkLoadState, handleChunkLoadErrors } from "./lib/chunkReloadGuard";
import { registerCoxServiceWorker } from "./pwa/serviceWorkerRegistration";

if (typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator) {
  void registerCoxServiceWorker();
}

handleChunkLoadErrors();

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
export const boot = import("./main")
  .then(({ startup }) => startup)
  .catch((error: unknown) => {
    if (!chunkLoadState.reloadScheduled) showBootError(error);
  });
