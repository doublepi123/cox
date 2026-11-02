import { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { useSystemComposerBanners } from "./useSystemComposerBanners";

const { retry } = vi.hoisted(() => ({ retry: vi.fn().mockResolvedValue(undefined) }));

vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => retry }));
vi.mock("../../connection/catalog", () => ({ environmentCatalog: { retryNow: {} } }));

const environmentId = EnvironmentId.make("local");

function Harness({
  phase,
  error = null,
}: {
  phase: EnvironmentConnectionPresentation["phase"];
  error?: string | null;
}) {
  const banners = useSystemComposerBanners({
    activeEnvironment: null,
    activeEnvironmentUnavailable: phase !== "connected",
    activeEnvironmentUnavailableState: {
      environmentId,
      label: "Local Cox",
      connection: { phase, error, traceId: null },
    },
    activeThreadEnvironmentId: environmentId,
    serverConfig: null,
    hasMultipleRegisteredEnvironments: false,
  });
  return banners.map((banner) => (
    <section key={banner.id} data-variant={banner.variant}>
      <div>{banner.title}</div>
      {banner.description ? <p>{banner.description}</p> : null}
    </section>
  ));
}

function testLanguage(language: "en" | "zh") {
  setLanguagePreference(language);
  return {
    [Symbol.dispose]() {
      setLanguagePreference("system");
      vi.clearAllMocks();
    },
  };
}

it("does not mislabel the initial connection as an unavailable server", async () => {
  using _language = testLanguage("en");
  await using screen = await render(<Harness phase="connecting" />, { router: false });
  await expect.element(screen.getByText("Connecting to the local server...")).toBeVisible();
  expect(screen.container.querySelector("section")?.dataset.variant).toBe("info");
  expect(screen.container.querySelector("button")).toBeNull();
});

it("localizes automatic reconnection, exposes the failure and retries the right environment", async () => {
  using _language = testLanguage("zh");
  await using screen = await render(<Harness phase="reconnecting" error="WebSocket closed" />, {
    router: false,
  });
  await expect.element(screen.getByText("连接已中断，正在自动重连…")).toBeVisible();
  await expect.element(screen.getByText("WebSocket closed")).toBeVisible();
  await screen.getByRole("button", { name: "重新连接" }).click();
  expect(retry).toHaveBeenCalledExactlyOnceWith(environmentId);
  await screen.rerender(<Harness phase="connected" />);
  expect(screen.container.querySelector("section")).toBeNull();
});

it.each([
  ["offline", "浏览器报告网络离线，连接已暂停。"],
  ["error", "无法连接本地服务，请确认 Cox 正在运行。"],
  ["unsupported", "客户端与服务端不兼容，请刷新页面或更新 Cox。"],
] as const)("distinguishes %s from automatic reconnection", async (phase, message) => {
  using _language = testLanguage("zh");
  await using screen = await render(<Harness phase={phase} />, { router: false });
  await expect.element(screen.getByText(message)).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "重新连接" })).toBeVisible();
});
