import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

export function createLocalApi(): LocalApi {
  return {
    dialogs: {
      confirm: async (message, options?: ConfirmDialogOptions) =>
        requestConfirmDialog(message, options) ?? false,
    },
    shell: {
      openExternal: async (url) => {
        const parsed = new URL(url, window.location.origin);
        if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
          throw new Error("Unsupported external link protocol.");
        }
        window.open(parsed.toString(), "_blank", "noopener,noreferrer");
      },
    },
    contextMenu: {
      show: async <Item extends string>(
        items: readonly ContextMenuItem<Item>[],
        position?: { x: number; y: number },
      ): Promise<Item | null> => showContextMenuFallback(items, position),
      close: async () => {
        dismissContextMenu();
      },
    },
    persistence: {
      getClientSettings: async () => readBrowserClientSettings(),
      setClientSettings: async (settings) => {
        await writeBrowserClientSettings(settings);
      },
    },
  };
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  return (cachedApi ??= createLocalApi());
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) throw new Error("Local API not found");
  return api;
}
