import type { DesktopClientUpdateState } from "@t3tools/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { DesktopClientUpdates } from "./DesktopClientUpdates";

const mocks = vi.hoisted(() => ({
  state: null as DesktopClientUpdateState | null,
  check: vi.fn(async () => undefined),
  download: vi.fn(async () => undefined),
  apply: vi.fn(async () => undefined),
  setPolicy: vi.fn(async () => undefined),
}));

vi.mock(import("../../hooks/useDesktopClientUpdate"), () => ({
  useDesktopClientUpdate: () => ({
    state: mocks.state,
    check: mocks.check,
    download: mocks.download,
    apply: mocks.apply,
    setPolicy: mocks.setPolicy,
  }),
}));

function setup(overrides: Partial<DesktopClientUpdateState> = {}) {
  vi.clearAllMocks();
  mocks.state = {
    currentVersion: "0.1.0",
    latestVersion: null,
    status: "idle",
    progress: null,
    message: null,
    installMode: "automatic",
    automaticChecks: true,
    ignoredVersion: null,
    ...overrides,
  };
}

function updateRow(screen: Awaited<ReturnType<typeof render>>) {
  return screen
    .getByText("Client updates", { exact: true })
    .element()
    .closest<HTMLElement>("[data-slot=settings-row]")!;
}

describe("desktop client update actions", () => {
  it("shows only the manual check in the default state", async () => {
    setup();
    await using screen = await render(<DesktopClientUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(1);
    await screen.getByRole("button", { name: "Check for client updates", exact: true }).click();
    expect(mocks.check).toHaveBeenCalledOnce();
    await expect
      .element(page.getByRole("switch", { name: "Automatic client update checks" }))
      .toBeChecked();
  });

  it("keeps download primary and moves ignore and repeated checks into the menu", async () => {
    setup({ status: "available", latestVersion: "0.2.0" });
    await page.viewport(390, 740);
    await using screen = await render(<DesktopClientUpdates />);
    const row = updateRow(screen);
    expect(row.querySelectorAll("button")).toHaveLength(2);
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
    await screen.getByRole("button", { name: "Client update actions", exact: true }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Check for client updates", exact: true }))
      .toBeVisible();
    await page.getByRole("menuitem", { name: "Ignore this version", exact: true }).click();
    expect(mocks.setPolicy).toHaveBeenCalledWith("ignore-version", "0.2.0");
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("keeps restart as the only ready-state action", async () => {
    setup({ status: "ready", latestVersion: "0.2.0" });
    await using screen = await render(<DesktopClientUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(1);
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it("keeps policy recovery available without another row-level button", async () => {
    setup({ automaticChecks: false, ignoredVersion: "0.2.0" });
    await using screen = await render(<DesktopClientUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: "Client update actions", exact: true }).click();
    await page
      .getByRole("menuitem", { name: "Restore automatic client update checks", exact: true })
      .click();
    expect(mocks.setPolicy).toHaveBeenCalledWith("automatic");
  });

  it("uses retry as the primary action for a failed download", async () => {
    setup({ status: "error", latestVersion: "0.2.0", message: "Download failed" });
    await using screen = await render(<DesktopClientUpdates />);
    expect(updateRow(screen).querySelectorAll("button")).toHaveLength(2);
    await screen.getByRole("button", { name: "Retry", exact: true }).click();
    expect(mocks.download).toHaveBeenCalledOnce();
  });
});
