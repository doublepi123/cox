import {
  createBrowserHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
  useRouter,
} from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useHistoryBackDismiss } from "./historyBackDismiss";

function Layer(props: { name: string; open: boolean; onBack: () => void; children?: ReactNode }) {
  useHistoryBackDismiss(props.open, props.onBack);
  return props.open ? <section aria-label={props.name}>{props.children}</section> : null;
}

/** A sidebar, and a panel that holds a picker, like the right panel's side chat composer. */
function Layers() {
  const router = useRouter();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const set = (name: string, value: boolean) =>
    setOpen((current) => {
      const next = new Set(current);
      if (value) next.add(name);
      else next.delete(name);
      return next;
    });
  const layer = (name: string, children?: ReactNode) => (
    <Layer name={name} open={open.has(name)} onBack={() => set(name, false)}>
      {children}
    </Layer>
  );
  const href = (step: number) => `${window.location.pathname}?step=${step}`;
  return (
    <>
      {["Sidebar", "Panel", "Picker"].map((name) => (
        <button key={name} type="button" onClick={() => set(name, !open.has(name))}>
          {`Toggle ${name}`}
        </button>
      ))}
      <button
        type="button"
        onClick={() => {
          set("Sidebar", false);
          void router.navigate({ href: href(2) });
        }}
      >
        Pick a thread
      </button>
      <button type="button" onClick={() => void router.navigate({ href: href(3) })}>
        Navigate
      </button>
      <button type="button" onClick={() => void router.navigate({ href: href(4), replace: true })}>
        Replace
      </button>
      {layer("Sidebar")}
      {layer("Panel", layer("Picker"))}
    </>
  );
}

async function mountOnBrowserRouter() {
  const stack = new AsyncDisposableStack();
  const startUrl = window.location.href;
  // Drops forward entries an earlier test left, so history.length counts what is behind us.
  window.history.pushState(null, "", startUrl);
  const history = createBrowserHistory();
  stack.defer(() => history.destroy());
  let loads = 0;
  const router = createRouter({
    routeTree: createRootRoute({
      loader: () => {
        loads += 1;
      },
      component: Layers,
    }),
    history,
  });
  await router.load();
  stack.use(await render(<RouterProvider router={router} />, { router: false }));
  await expect.element(page.getByRole("button", { name: "Toggle Sidebar" })).toBeInTheDocument();
  const start = {
    length: window.history.length,
    loads,
    routerKey: window.history.state?.__TSR_key as string,
    search: window.location.search,
  };
  const toggle = (name: string) => page.getByRole("button", { name: `Toggle ${name}` }).click();
  const region = (name: string) => page.getByRole("region", { name });
  const length = (extra: number) =>
    expect.poll(() => window.history.length).toBe(start.length + extra);
  const atRoute = async (search: string) => {
    await expect.poll(() => window.history.state?.coxBackDismiss).toBeUndefined();
    await expect.poll(() => window.location.search).toBe(search);
    expect(router.state.location.href).toBe(router.latestLocation.href);
    expect(router.state.location.searchStr).toBe(search);
  };
  const atStart = async () => {
    await atRoute(start.search);
    expect(window.location.href).toBe(startUrl);
    expect(window.history.state?.__TSR_key).toBe(start.routerKey);
  };
  return {
    start,
    router,
    toggle,
    region,
    length,
    atRoute,
    atStart,
    loads: () => loads,
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

it("closes stacked overlays one at a time on Back", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Panel");
  await app.length(1);
  await app.toggle("Picker");
  await app.length(2);
  expect(app.loads()).toBe(app.start.loads);
  const pickerEntry = window.history.state?.coxBackDismiss;

  window.history.back();
  await expect.element(app.region("Picker")).not.toBeInTheDocument();
  await expect.element(app.region("Panel")).toBeInTheDocument();
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");
  expect(window.history.state?.coxBackDismiss).not.toBe(pickerEntry);

  window.history.back();
  await expect.element(app.region("Panel")).not.toBeInTheDocument();
  await app.atStart();
  expect(app.loads()).toBe(app.start.loads);
});

it("keeps the entry of an overlay that stays open when the one under it closes", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Sidebar");
  await app.toggle("Panel");
  await app.length(2);

  await app.toggle("Sidebar");
  await expect.element(app.region("Sidebar")).not.toBeInTheDocument();
  await expect.element(app.region("Panel")).toBeInTheDocument();
  await app.length(1);
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");

  window.history.back();
  await expect.element(app.region("Panel")).not.toBeInTheDocument();
  await app.atStart();
  expect(app.loads()).toBe(app.start.loads);
});

it("pops every entry when an overlay closes with another inside it", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Panel");
  await app.toggle("Picker");
  await app.length(2);

  await app.toggle("Panel");
  await expect.element(app.region("Panel")).not.toBeInTheDocument();
  await app.atStart();

  // The next open replaces the forward entries, so nothing piled up.
  await app.toggle("Sidebar");
  await app.length(1);
  window.history.back();
  await app.atStart();
});

it("lands a route picked from an overlay where the overlay opened", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Sidebar");
  await app.length(1);

  await page.getByRole("button", { name: "Pick a thread" }).click();
  await expect.poll(() => app.router.state.location.searchStr).toBe("?step=2");
  await app.atRoute("?step=2");
  await app.length(1);

  // Back leaves the new route straight away, with no dead entry in between.
  window.history.back();
  await expect.poll(() => app.router.state.location.searchStr).toBe(app.start.search);
  await app.atStart();
});

it("moves the entry of an overlay that stays open above a pushed route", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Sidebar");
  await page.getByRole("button", { name: "Navigate" }).click();
  await expect.poll(() => app.router.state.location.searchStr).toBe("?step=3");
  await app.length(2);
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");
  expect(window.location.search).toBe("?step=3");

  window.history.back();
  await expect.element(app.region("Sidebar")).not.toBeInTheDocument();
  await app.atRoute("?step=3");
  window.history.back();
  await expect.poll(() => app.router.state.location.searchStr).toBe(app.start.search);
  await app.atStart();
});

it("replaces the route under an overlay rather than the overlay's entry", async () => {
  await using app = await mountOnBrowserRouter();
  await app.toggle("Sidebar");
  await page.getByRole("button", { name: "Replace" }).click();
  await expect.poll(() => app.router.state.location.searchStr).toBe("?step=4");
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");
  await app.length(1);

  window.history.back();
  await expect.element(app.region("Sidebar")).not.toBeInTheDocument();
  await app.atRoute("?step=4");
  expect(window.history.state?.__TSR_key).not.toBe(app.start.routerKey);
});

it("closes the overlays and lets the router go when Back goes past them", async () => {
  await using app = await mountOnBrowserRouter();
  await page.getByRole("button", { name: "Navigate" }).click();
  await expect.poll(() => app.router.state.location.searchStr).toBe("?step=3");
  await app.toggle("Panel");
  await app.toggle("Picker");
  await app.length(3);

  window.history.go(-3);
  await expect.element(app.region("Panel")).not.toBeInTheDocument();
  await expect.poll(() => app.router.state.location.searchStr).toBe(app.start.search);
  await app.atStart();
  expect(window.history.length).toBe(app.start.length + 3);
});

it("leaves a push made outside the router alone when the overlay closes", async () => {
  const startUrl = window.location.href;
  window.history.pushState(null, "", startUrl);
  await using _screen = await render(<Layers />, { router: false });
  const go = vi.spyOn(window.history, "go");
  await page.getByRole("button", { name: "Toggle Panel" }).click();
  await expect.poll(() => typeof window.history.state?.coxBackDismiss).toBe("string");

  window.history.pushState({ elsewhere: true }, "", "?elsewhere");
  await page.getByRole("button", { name: "Toggle Panel" }).click();
  await expect.element(page.getByRole("region", { name: "Panel" })).not.toBeInTheDocument();
  expect(go).not.toHaveBeenCalled();
  expect(window.location.search).toBe("?elsewhere");
  go.mockRestore();
  window.history.replaceState(null, "", startUrl);
});
