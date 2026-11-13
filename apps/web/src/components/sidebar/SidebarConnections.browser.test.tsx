import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render, stubGlobal } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { SidebarConnections } from "./SidebarConnections";
import { SidebarProvider } from "../ui/sidebar";
import { ToastProvider, toastManager } from "../ui/toast";

vi.mock(import("../../state/environments"), () => ({
  usePrimaryEnvironment: () => ({ label: "Build server" }) as never,
}));

describe("desktop connection switching", () => {
  it("opens the native connection manager from the current remote instance", async () => {
    const openConnections = vi.fn(async () => {});
    using _bridge = stubGlobal("coxDesktop", { openConnections });
    await using screen = await render(
      <SidebarProvider>
        <SidebarConnections />
      </SidebarProvider>,
    );
    await screen.getByRole("button", { name: "Connections", exact: true }).click();
    expect(openConnections).toHaveBeenCalledOnce();
  });

  it("keeps browser and older desktop pages free of a local connection bridge", async () => {
    using _bridge = stubGlobal("coxDesktop", undefined);
    await using screen = await render(
      <SidebarProvider>
        <SidebarConnections />
      </SidebarProvider>,
    );
    expect(screen.container.textContent).toBe("");
  });

  it("shows the current instance in Chinese mobile navigation", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    using _bridge = stubGlobal("coxDesktop", { openConnections: vi.fn(async () => {}) });
    await using screen = await render(
      <SidebarProvider>
        <SidebarConnections />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Build server", { exact: true })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "连接", exact: true })).toBeVisible();
  });

  it("reports a rejected native connection manager and allows another attempt", async () => {
    const openConnections = vi
      .fn(async () => undefined)
      .mockRejectedValueOnce(new Error("Connection manager unavailable"));
    using _bridge = stubGlobal("coxDesktop", { openConnections });
    using notices = vi.spyOn(toastManager, "add");
    await using screen = await render(
      <ToastProvider timeout={0}>
        <SidebarProvider>
          <SidebarConnections />
        </SidebarProvider>
      </ToastProvider>,
    );
    const button = screen.getByRole("button", { name: "Connections", exact: true });
    await button.click();
    await expect
      .element(page.getByText("Could not open connections", { exact: true }))
      .toBeVisible();
    await button.click();
    expect(openConnections).toHaveBeenCalledTimes(2);
    expect(notices).toHaveBeenCalledOnce();
    const toastId = notices.mock.results[0]?.value;
    if (toastId !== undefined) toastManager.close(toastId);
  });
});
