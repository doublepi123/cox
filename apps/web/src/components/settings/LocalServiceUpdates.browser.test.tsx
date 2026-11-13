import { describe, expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
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
  reload: vi.fn(async () => {}),
  check: vi.fn(async () => {}),
  download: vi.fn(async () => {}),
  apply: vi.fn(async () => {}),
  useRealHook: false,
}));

const response = (state: LocalServiceUpdateState) =>
  new Response(JSON.stringify(state), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

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
vi.mock(import("../../hooks/useLocalServiceUpdate"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    useLocalServiceUpdate: (enabled: boolean) =>
      mocks.useRealHook
        ? actual.useLocalServiceUpdate(enabled)
        : {
            state: mocks.state,
            busy: false,
            error: null,
            reload: mocks.reload,
            check: mocks.check,
            download: mocks.download,
            apply: mocks.apply,
          },
  };
});

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

  it("polls after apply, clears a transient restart error and stops when healthy", async () => {
    using _timers = fakeTimers();
    mocks.useRealHook = true;
    using _realHook = {
      [Symbol.dispose]: () => {
        mocks.useRealHook = false;
      },
    };
    const ready = {
      ...mocks.state,
      status: "ready" as const,
      latestVersion: "0.2.0",
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(response(ready))
      .mockResolvedValueOnce(response({ ...ready, status: "restarting" }))
      .mockRejectedValueOnce(new Error("Service down"))
      .mockResolvedValue(response({ ...ready, status: "idle" }));
    using _fetch = stubGlobal("fetch", fetchMock);
    await using screen = await render(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Restart and update" }).click();
    await expect
      .element(screen.getByText("Restarting Cox. This page will reconnect when it is ready."))
      .toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect.element(screen.getByText("Service down")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect.element(screen.getByText("Cox is up to date.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Service down");
    fetchMock.mockClear();
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a transient polling error observed from an initially restarting service", async () => {
    using _timers = fakeTimers();
    mocks.useRealHook = true;
    using _realHook = {
      [Symbol.dispose]: () => {
        mocks.useRealHook = false;
      },
    };
    const restarting = {
      ...mocks.state,
      status: "restarting" as const,
      latestVersion: "0.2.0",
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(response(restarting))
      .mockRejectedValueOnce(new Error("Service down"))
      .mockResolvedValue(response({ ...restarting, status: "idle" }));
    using _fetch = stubGlobal("fetch", fetchMock);
    await using screen = await render(<LocalServiceUpdates />);
    await expect
      .element(screen.getByText("Restarting Cox. This page will reconnect when it is ready."))
      .toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect.element(screen.getByText("Service down")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    await expect.element(screen.getByText("Cox is up to date.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Service down");
  });

  it("keeps a failed initial state visible and retries the state request", async () => {
    mocks.useRealHook = true;
    using _realHook = {
      [Symbol.dispose]: () => {
        mocks.useRealHook = false;
      },
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockRejectedValueOnce(new Error("Service down"))
      .mockResolvedValue(response({ ...mocks.state, status: "idle", latestVersion: "0.1.58" }));
    using _fetch = stubGlobal("fetch", fetchMock);
    await using screen = await render(<LocalServiceUpdates />);
    await expect.element(screen.getByText("Service down")).toBeVisible();
    await screen.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(screen.getByText("Cox is up to date.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Service down");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/local-service-update");
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("GET");
  });

  it("translates the status fallback and active-work feedback in Chinese", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    mocks.useRealHook = true;
    using _realHook = {
      [Symbol.dispose]: () => {
        mocks.useRealHook = false;
      },
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValue(
        response({
          ...mocks.state,
          status: "ready",
          latestVersion: "0.2.0",
          message: "Wait for active agent turns to finish before updating Cox.",
        }),
      );
    using _fetch = stubGlobal("fetch", fetchMock);
    await using screen = await render(<LocalServiceUpdates />);
    await expect.element(screen.getByText("更新请求失败（503）。")).toBeVisible();
    await screen.getByRole("button", { name: "重试", exact: true }).click();
    await expect
      .element(screen.getByText("请等待运行中的 Agent 任务结束后再更新 Cox。"))
      .toBeVisible();
  });

  it("translates a rejected active-work update in Chinese", async () => {
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    mocks.useRealHook = true;
    using _realHook = {
      [Symbol.dispose]: () => {
        mocks.useRealHook = false;
      },
    };
    const fetchMock = vi.fn<typeof fetch>();
    fetchMock
      .mockResolvedValueOnce(
        response({ ...mocks.state, status: "ready", latestVersion: "0.2.0", message: null }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ message: "Wait for active agent turns to finish before updating Cox." }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
      );
    using _fetch = stubGlobal("fetch", fetchMock);
    await using screen = await render(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "重启并更新", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "重启并更新" }).click();
    await expect
      .element(screen.getByText("请等待运行中的 Agent 任务结束后再更新 Cox。"))
      .toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shows active-work ready feedback and permits a retry", async () => {
    mocks.apply.mockClear();
    mocks.state = {
      ...mocks.state,
      status: "ready",
      latestVersion: "0.2.0",
      message: "Wait for active agent turns to finish before updating Cox.",
    };
    await using screen = await render(<LocalServiceUpdates />);
    await expect
      .element(screen.getByText("Wait for active agent turns to finish before updating Cox."))
      .toBeVisible();
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Restart and update" }).click();
    expect(mocks.apply).toHaveBeenCalledOnce();
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    mocks.state = { ...mocks.state, message: null };
    await screen.rerender(<LocalServiceUpdates />);
    await screen.getByRole("button", { name: "Restart and update", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Restart and update" }).click();
    expect(mocks.apply).toHaveBeenCalledTimes(2);
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
