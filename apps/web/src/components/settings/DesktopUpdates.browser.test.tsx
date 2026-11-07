import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { DesktopUpdates } from "./DesktopUpdates";

const mocks = vi.hoisted(() => ({
  clientState: null as DesktopClientUpdateState | null,
  backendState: null as DesktopBackendUpdateState | null,
  checkClient: vi.fn(async () => undefined),
  downloadClient: vi.fn(async () => undefined),
  applyClient: vi.fn(async () => undefined),
  setClientPolicy: vi.fn(async () => undefined),
  checkBackend: vi.fn(async () => undefined),
  installBackend: vi.fn(async () => undefined),
  setBackendPolicy: vi.fn(async () => undefined),
}));

vi.mock(import("../../hooks/useDesktopClientUpdate"), () => ({
  useDesktopClientUpdate: () => ({
    state: mocks.clientState,
    check: mocks.checkClient,
    download: mocks.downloadClient,
    apply: mocks.applyClient,
    setPolicy: mocks.setClientPolicy,
  }),
}));

vi.mock(import("../../hooks/useDesktopBackendUpdate"), () => ({
  useDesktopBackendUpdate: () => ({
    state: mocks.backendState,
    check: mocks.checkBackend,
    install: mocks.installBackend,
    setPolicy: mocks.setBackendPolicy,
  }),
}));

function setup(
  client: Partial<DesktopClientUpdateState> = {},
  backend: Partial<DesktopBackendUpdateState> = {},
) {
  vi.clearAllMocks();
  mocks.clientState = {
    currentVersion: "0.2.0",
    latestVersion: "0.2.0",
    status: "idle",
    progress: null,
    message: null,
    installMode: "automatic",
    automaticChecks: true,
    ignoredVersion: null,
    ...client,
  };
  mocks.backendState = {
    desktopVersion: "0.2.0",
    bundledVersion: "0.1.0",
    currentVersion: "0.1.0",
    latestVersion: "0.1.0",
    status: "idle",
    progress: null,
    message: null,
    automaticChecks: true,
    ignoredVersion: null,
    ...backend,
  };
}

function updateRow(screen: Awaited<ReturnType<typeof render>>) {
  return screen
    .getByText("Software updates", { exact: true })
    .element()
    .closest<HTMLElement>("[data-slot=settings-row]")!;
}

describe("desktop update actions", () => {
  it("shows one check action for the client and backend in the default state", async () => {
    setup();
    await using screen = await render(<DesktopUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(1);
    await screen.getByRole("button", { name: "Check for updates", exact: true }).click();
    expect(mocks.checkClient).toHaveBeenCalledOnce();
    expect(mocks.checkBackend).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("switch", { name: "Automatic update checks" }))
      .toBeChecked();
  });

  it("downloads both available updates from one primary action", async () => {
    setup(
      { status: "available", latestVersion: "0.3.0" },
      { status: "available", latestVersion: "0.2.0" },
    );
    await page.viewport(390, 740);
    await using screen = await render(<DesktopUpdates />);
    const row = updateRow(screen);
    expect(row.querySelectorAll("button")).toHaveLength(2);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    await screen.getByRole("button", { name: "Download updates", exact: true }).click();
    expect(mocks.downloadClient).toHaveBeenCalledOnce();
    expect(mocks.installBackend).toHaveBeenCalledOnce();
    await screen.getByRole("button", { name: "Update actions", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Check for updates", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Ignore this client version", exact: true }).click();
    expect(mocks.setClientPolicy).toHaveBeenCalledWith("ignore-version", "0.3.0");
  });

  it("keeps backend ignore actions in the shared menu", async () => {
    setup({}, { status: "available", latestVersion: "0.2.0" });
    using _bridge = stubGlobal("coxDesktop", { setBackendUpdatePolicy: vi.fn() });
    await using screen = await render(<DesktopUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: "Update actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Ignore this Cox version", exact: true }).click();
    expect(mocks.setBackendPolicy).toHaveBeenCalledWith("ignore-version", "0.2.0");
    expect(mocks.downloadClient).not.toHaveBeenCalled();
  });

  it("keeps restart as the only ready-state action", async () => {
    setup({ status: "ready", latestVersion: "0.3.0" });
    await using screen = await render(<DesktopUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(1);
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    expect(mocks.applyClient).toHaveBeenCalledOnce();
  });

  it("keeps policy recovery in the shared menu", async () => {
    setup({ automaticChecks: false, ignoredVersion: "0.3.0" });
    await using screen = await render(<DesktopUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: "Update actions", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Restore automatic update checks", exact: true })
      .click();
    expect(mocks.setClientPolicy).toHaveBeenCalledWith("automatic");
    expect(mocks.setBackendPolicy).toHaveBeenCalledWith("automatic");
  });

  it("uses one retry action for a failed download", async () => {
    setup({ status: "error", latestVersion: "0.3.0", message: "Download failed" });
    await using screen = await render(<DesktopUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: "Retry", exact: true }).click();
    expect(mocks.downloadClient).toHaveBeenCalledOnce();
    expect(mocks.installBackend).not.toHaveBeenCalled();
  });

  it("controls both automatic update policies with one switch", async () => {
    setup();
    await using _screen = await render(<DesktopUpdates />);
    await page.getByRole("switch", { name: "Automatic update checks" }).click();
    expect(mocks.setClientPolicy).toHaveBeenCalledWith("never");
    expect(mocks.setBackendPolicy).toHaveBeenCalledWith("never");
  });
});
