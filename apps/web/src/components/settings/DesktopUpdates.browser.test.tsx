import type { DesktopBackendUpdateState, DesktopClientUpdateState } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render, stubGlobal } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
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
  applyBackend: vi.fn(async () => undefined),
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
    apply: mocks.applyBackend,
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
  it("offers immediate application of a staged Cox update without downloading it again", async () => {
    setup({}, { status: "ready", latestVersion: "0.2.0" });
    using _bridge = stubGlobal("coxDesktop", { applyBackendUpdate: vi.fn() });
    await using screen = await render(<DesktopUpdates />);
    await screen.getByRole("button", { name: "Update now", exact: true }).click();
    expect(mocks.applyBackend).toHaveBeenCalledOnce();
    expect(mocks.installBackend).not.toHaveBeenCalled();
    expect(mocks.applyClient).not.toHaveBeenCalled();
  });

  it("keeps downloaded Cox updates usable with clients that cannot restart from the page", async () => {
    setup({}, { status: "ready", latestVersion: "0.2.0" });
    using _bridge = stubGlobal("coxDesktop", {});
    await using screen = await render(<DesktopUpdates />);
    await expect
      .element(screen.getByRole("button", { name: "Update now", exact: true }))
      .not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Check for updates", exact: true }))
      .toBeEnabled();
    expect(mocks.applyBackend).not.toHaveBeenCalled();
  });

  it.each(["available", "checking", "downloading", "ready", "error"] as const)(
    "keeps the target client version visible while %s even when Cox is ready",
    async (status) => {
      setup({ status, latestVersion: "0.3.0" }, { status: "ready", latestVersion: "0.2.0" });
      await using screen = await render(<DesktopUpdates />);
      const current = screen
        .getByText("Client version", { exact: true })
        .element()
        .closest("[data-slot=settings-row]")!;
      const target = screen
        .getByText("Client update version", { exact: true })
        .element()
        .closest("[data-slot=settings-row]")!;
      expect(current.querySelector("code")?.textContent).toBe("0.2.0");
      expect(target.querySelector("code")?.textContent).toBe("0.3.0");
    },
  );

  it.each([null, "0.2.0"])(
    "does not invent a target version when the latest version is %s",
    async (latestVersion) => {
      setup({ status: "checking", latestVersion });
      await using screen = await render(<DesktopUpdates />);
      await expect
        .element(screen.getByText("Client update version", { exact: true }))
        .not.toBeInTheDocument();
    },
  );

  it("does not present an ignored client version as a pending update", async () => {
    setup({ latestVersion: "0.3.0", ignoredVersion: "0.3.0" });
    await using screen = await render(<DesktopUpdates />);
    await expect
      .element(screen.getByText("Client update version", { exact: true }))
      .not.toBeInTheDocument();
  });

  it("labels a prepared manual client update in Chinese", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    setup({ status: "ready", latestVersion: "0.3.0", installMode: "manual" });
    await using screen = await render(<DesktopUpdates />);
    const target = screen
      .getByText("待更新客户端版本", { exact: true })
      .element()
      .closest("[data-slot=settings-row]")!;
    expect(target.querySelector("code")?.textContent).toBe("0.3.0");
    await expect.element(screen.getByRole("button", { name: "打开安装包" })).toBeVisible();
  });

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
