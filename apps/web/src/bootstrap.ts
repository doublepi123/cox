import { showBootError } from "./lib/bootError";
import { registerCoxServiceWorker } from "./pwa/serviceWorkerRegistration";

if (typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator) {
  void registerCoxServiceWorker();
}

// Shared dev chunks need the React refresh preamble first. Catch failures before React mounts.
void import("./main").then(({ startup }) => startup).catch(showBootError);
