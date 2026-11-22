import { EnvironmentId, ThreadId, type DesktopComputerUseState } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock("~/hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import { render, stubGlobal } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { ChatHeader } from "./ChatHeader";

function englishLanguage() {
  setLanguagePreference("en");
  return { [Symbol.dispose]: () => setLanguagePreference("system") };
}

function header(title: string, computerControlAgentSupported = false) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
        computerControlAgentSupported={computerControlAgentSupported}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

it("shows the Windows computer-control indicator and capability names", async () => {
  using _language = englishLanguage();
  const state: DesktopComputerUseState = {
    supported: true,
    enabled: true,
    engine: "ready",
    engineMessage: null,
    permissions: { screenRecording: "denied", accessibility: "granted", input: "denied" },
    appName: "Cox",
    appPath: "C:\\Program Files\\Cox\\Cox.exe",
    macosVersion: null,
    restartRequired: false,
    stopped: false,
    ready: false,
  };
  using _bridge = stubGlobal("coxDesktop", {
    platform: "win32",
    getComputerUse: vi.fn(async () => state),
    onComputerUse: vi.fn(() => () => {}),
  });
  await using screen = await render(header("Windows control", true));
  const indicator = screen.getByRole("button", {
    name: "Open computer control settings: Computer control waiting for setup",
    exact: true,
  });
  await expect.element(indicator).toBeVisible();
  await indicator.hover();
  await expect
    .element(page.getByText("Not ready: Screen capture, Input and stop shortcut", { exact: false }))
    .toBeVisible();
});
