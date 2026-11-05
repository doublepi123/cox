import { RouterProvider } from "@tanstack/react-router";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { DesktopShell } from "./components/DesktopShell";

// Keep webviews outside the router but inside its atom registry so route changes preserve them.
export function AppRoot({ router }: { readonly router: AppRouter }) {
  return (
    <AppAtomRegistryProvider>
      <DesktopShell>
        <RouterProvider router={router} />
      </DesktopShell>
    </AppAtomRegistryProvider>
  );
}
