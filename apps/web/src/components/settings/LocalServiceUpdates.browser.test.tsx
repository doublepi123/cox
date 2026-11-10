import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import "~/index.css";
import { setLanguagePreference } from "../../i18n";
import { LocalServiceUpdates } from "./LocalServiceUpdates";
import type { LocalServiceUpdateState } from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  supported: true,
  permitted: true,
  state: {
    supported: true,
    currentVersion: "0.1.58",
    latestVersion: null,
    status: "idle",
    message: null,
    progress: null,
    backup: null,
  } as LocalServiceUpdateState,
  check: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  apply: vi.fn(async () => {}),
}));

vi.mock(import("@effect/atom-react"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useAtomValue: () => ({
      environment: {
        environmentId: "local",
        capabilities: { localServiceUpdate: mocks.supported },
      },
    }),
  };
});
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => mocks.permitted,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    children,
  }: {
    title: React.ReactNode;
    description?: React.ReactNode;
    control?: React.ReactNode;
    children?: React.ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <div>{description}</div>
      {control}
      {children}
    </div>
  ),
}));
vi.mock(import("../../hooks/useLocalServiceUpdate"), () => ({
  useLocalServiceUpdate: () => ({
    state: mocks.state,
    busy: false,
    error: null,
    check: mocks.check,
    download: mocks.download,
    apply: mocks.apply,
  }),
}));

describe("local service update settings", () => {
  it("checks the current server, prepares an update and confirms the restart", async () => {
    mocks.state = { ...mocks.state, status: "idle" };
    await using screen = await render(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "Check for updates" }).click();
    expect(mocks.check).toHaveBeenCalledOnce();
    mocks.state = { ...mocks.state, status: "available", latestVersion: "0.2.0" };
    await screen.rerender(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "Download update" }).click();
    expect(mocks.download).toHaveBeenCalledOnce();
    mocks.state = {
      ...mocks.state,
      status: "ready",
      backup: { directory: "/backup", database: "/backup/statev2.sqlite" },
    };
    await screen.rerender(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    expect(mocks.apply).not.toHaveBeenCalled();
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Restart and update" }).click();
    expect(mocks.apply).toHaveBeenCalledOnce();
  });

  it("does not offer local lifecycle privileges to unsupported or under-scoped sessions", async () => {
    mocks.supported = false;
    await using screen = await render(<LocalServiceUpdates />);
    expect(screen.container.textContent).toBe("");
    mocks.supported = true;
    mocks.permitted = false;
    await screen.rerender(<LocalServiceUpdates />);
    expect(screen.container.textContent).toBe("");
    mocks.permitted = true;
  });

  it("shows Chinese progress and restart state", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    mocks.state = {
      ...mocks.state,
      status: "restarting",
      latestVersion: "0.2.0",
      progress: null,
      backup: null,
    };
    await using screen = await render(<LocalServiceUpdates />);
    await expect.element(screen.getByText("正在重启 Cox，就绪后页面会重新连接。")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "检查更新" })).toBeDisabled();
    mocks.state = { ...mocks.state, status: "idle", latestVersion: null };
  });
});
