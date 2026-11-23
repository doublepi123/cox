import React from "react";
import ReactDOM from "react-dom/client";

import "@fontsource-variable/inter";
import "./index.css";
import "./lib/browserSafeArea";
import "./lib/historyBackDismiss";

import { initializeI18n } from "./i18n";

import { trackKeyboardLayout } from "./keyboardLayout";
import { startAppServices } from "./appInit";
import { AppRoot } from "./AppRoot";
import { chunkLoadState } from "./lib/chunkReloadGuard";

initializeI18n();
const stopTrackingKeyboardLayout = trackKeyboardLayout();
import.meta.hot?.dispose(stopTrackingKeyboardLayout);

const router = startAppServices();

const app = <AppRoot router={router} />;

export const startup = router
  .load()
  .then(() => {
    // Route chunk failures resolve router.load() and surface later through the error boundary.
    if (chunkLoadState.reloadScheduled) return;
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>{app}</React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (chunkLoadState.reloadScheduled) return;
    throw error;
  });
