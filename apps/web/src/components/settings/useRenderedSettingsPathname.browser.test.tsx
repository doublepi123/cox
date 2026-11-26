import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { useRenderedSettingsPathname } from "./useRenderedSettingsPathname";

function Chrome() {
  return (
    <>
      <p data-testid="chrome">{useRenderedSettingsPathname()}</p>
      <Outlet />
    </>
  );
}

it("names the page on screen, not the one still loading", async () => {
  let resolveSlowPage!: () => void;
  const slowPage = new Promise<void>((resolve) => {
    resolveSlowPage = resolve;
  });
  const root = createRootRoute({ component: Chrome });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({
        getParentRoute: () => root,
        path: "/settings/general",
        component: () => <p>General page</p>,
      }),
      createRoute({
        getParentRoute: () => root,
        path: "/settings/storage",
        // Stands in for a lazy route chunk that has not arrived yet.
        loader: () => slowPage,
        component: () => <p>Storage page</p>,
      }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/settings/general"] }),
  });
  await using screen = await render(<RouterProvider router={router} />, { router: false });
  const chrome = screen.getByTestId("chrome");
  await expect.element(chrome).toHaveTextContent("/settings/general");

  const navigation = router.navigate({ to: "/settings/storage" });
  await expect.poll(() => router.state.location.pathname).toBe("/settings/storage");
  await expect.element(screen.getByText("General page")).toBeVisible();
  await expect.element(chrome).toHaveTextContent("/settings/general");

  resolveSlowPage();
  await navigation;
  await expect.element(screen.getByText("Storage page")).toBeVisible();
  await expect.element(chrome).toHaveTextContent("/settings/storage");
});
