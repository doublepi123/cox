import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const setup = vi.hoisted(() => ({
  auth: null as ProviderAuthState | null,
  installation: null as ProviderInstallState | null,
  authState: vi.fn(() => "auth"),
  installState: vi.fn(() => "installation"),
  startAuth: vi.fn(),
  completeAuth: vi.fn(),
  respondAuth: vi.fn(),
  cancelAuth: vi.fn(),
  logoutAuth: vi.fn(),
  startInstall: vi.fn(),
  cancelInstall: vi.fn(),
  removeInstall: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providerAuthState: setup.authState as never,
      providerInstallState: setup.installState as never,
      startProviderAuth: setup.startAuth as never,
      completeProviderAuth: setup.completeAuth as never,
      respondProviderAuth: setup.respondAuth as never,
      cancelProviderAuth: setup.cancelAuth as never,
      logoutProviderAuth: setup.logoutAuth as never,
      startProviderInstall: setup.startInstall as never,
      cancelProviderInstall: setup.cancelInstall as never,
      removeProviderInstallation: setup.removeInstall as never,
    },
  };
});
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: ((command: unknown) => command) as never,
}));
const queryListeners = vi.hoisted(() => new Set<() => void>());
vi.mock(import("../../state/query"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    queryListeners.add(listener);
    return () => queryListeners.delete(listener);
  };
  return {
    ...(await original()),
    useEnvironmentQuery: ((atom: string) => ({
      data: useSyncExternalStore(subscribe, () =>
        atom === "auth" ? setup.auth : setup.installation,
      ),
      error: null,
      isPending: false,
      refresh: vi.fn(),
    })) as never,
  };
});
const publish = () =>
  act(async () => {
    for (const listener of queryListeners) listener();
  });
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs: { confirm: setup.confirm } }) as never,
}));

import { ProviderSetupSection } from "./ProviderSetupSection";
import { GrokSetupSection } from "./GrokSetupSection";

const environmentId = EnvironmentId.make("remote-google");
const instanceId = ProviderInstanceId.make("antigravity_work");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("antigravity"),
  installed: true,
  enabled: true,
  version: "test-version",
  status: "error",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-09-02T00:00:00.000Z",
  models: [],
  skills: [],
  slashCommands: [],
  setup: { canAuthenticate: true, canInstall: true },
};

function authState(patch: Partial<ProviderAuthState> = {}): ProviderAuthState {
  return {
    instanceId,
    phase: "waiting",
    flowId: "flow-1",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=test-only",
    expiresAt: "2026-09-02T00:05:00.000Z",
    message: null,
    ...patch,
  };
}

interface SectionOptions {
  readOnly?: boolean;
  provider?: ServerProvider;
  enabled?: boolean;
  binaryPath?: string;
}

function section(options: SectionOptions = {}) {
  return (
    <ProviderSetupSection
      environmentId={environmentId}
      environmentLabel="Remote Google device"
      instanceId={instanceId}
      provider={options.provider ?? provider}
      binaryPath={options.binaryPath}
      enabled={options.enabled ?? true}
      readOnly={options.readOnly ?? false}
      onEnable={vi.fn()}
    />
  );
}

async function renderSetup(options: SectionOptions = {}) {
  const screen = await render(section(options));
  const { container } = screen;
  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (element) => element.textContent === label || element.getAttribute("aria-label") === label,
    ) ?? null;
  return Object.assign(screen, {
    button,
    async click(label: string) {
      const target = button(label);
      expect(target, `button ${label}`).not.toBeNull();
      expect(target!.disabled, `${label} disabled`).toBe(false);
      await act(async () => target!.click());
    },
    occurrences: (text: string) => (container.textContent ?? "").split(text).length - 1,
    callbackInput: () =>
      container.querySelector<HTMLInputElement>(`[id="provider-callback-${instanceId}"]`)!,
  });
}

function resetSetup() {
  vi.clearAllMocks();
  setup.auth = authState();
  setup.installation = {
    driver: ProviderDriverKind.make("antigravity"),
    operationId: null,
    phase: "idle",
    downloadedBytes: 0,
    totalBytes: null,
    version: null,
    installedVersion: null,
    canRemove: false,
    message: null,
  };
  for (const command of [
    setup.startAuth,
    setup.completeAuth,
    setup.cancelAuth,
    setup.logoutAuth,
    setup.startInstall,
    setup.cancelInstall,
    setup.removeInstall,
  ]) {
    command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  }
  setup.confirm.mockReset().mockResolvedValue(false);
}

function grokSection(patch: Partial<ServerProvider> = {}, readOnly = false) {
  return (
    <GrokSetupSection
      environmentId={environmentId}
      environmentLabel="Local machine"
      instanceId={instanceId}
      provider={{ ...provider, driver: ProviderDriverKind.make("grok"), ...patch }}
      enabled
      readOnly={readOnly}
      onEnable={vi.fn()}
    />
  );
}

describe("Grok Build setup", () => {
  it("installs Grok for the selected instance before an install snapshot arrives", async () => {
    resetSetup();
    setup.installation = null;
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    await using screen = await render(grokSection({ installed: false }));
    await expect
      .element(screen.getByRole("button", { name: "Sign in", exact: true }))
      .toBeDisabled();
    await screen.getByRole("button", { name: "Install Grok", exact: true }).click();
    expect(setup.startInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
  });

  it("cancels installation and blocks sign-in until installation finishes", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      driver: ProviderDriverKind.make("grok"),
      phase: "downloading",
      operationId: "grok-install-1",
    };
    await using screen = await render(grokSection({ installed: false }));
    await expect
      .element(screen.getByRole("button", { name: "Sign in", exact: true }))
      .toBeDisabled();
    await screen.getByRole("button", { name: "Cancel installation", exact: true }).click();
    expect(setup.cancelInstall).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, operationId: "grok-install-1" },
    });
    setup.installation = {
      ...setup.installation!,
      phase: "succeeded",
      installedVersion: "1.2.3",
      source: "managed",
    };
    await publish();
    await expect
      .element(screen.getByRole("button", { name: "Sign in", exact: true }))
      .toBeEnabled();
  });

  it("starts sign-in and presents the device code with browser and cancel actions", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    await using screen = await render(grokSection());
    await screen.getByRole("button", { name: "Sign in", exact: true }).click();
    expect(setup.startAuth).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    setup.auth = authState({
      interaction: {
        type: "deviceCode",
        id: "device-code",
        url: "https://accounts.x.ai/oauth2/device?user_code=TEST-CODE",
        userCode: "TEST-CODE",
      },
    });
    await publish();
    await expect.element(screen.getByText("TEST-CODE", { exact: true })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Open browser", exact: true }))
      .toBeEnabled();
    await screen.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
    expect(setup.cancelAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1" },
    });
  });

  it("shows installation failure and lets the user retry", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      phase: "failed",
      message: "Installation failed",
    };
    await using screen = await render(grokSection({ installed: false }));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Installation failed");
    await screen.getByRole("button", { name: "Retry installation", exact: true }).click();
    expect(setup.startInstall).toHaveBeenCalledOnce();
  });

  it("only offers a managed Grok update when a newer version has been confirmed", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      driver: ProviderDriverKind.make("grok"),
      installedVersion: "1.0.70",
      source: "managed",
    };
    const advisory = {
      status: "behind_latest" as const,
      currentVersion: "1.0.70",
      latestVersion: "1.0.71",
      updateCommand: null,
      canUpdate: false,
      checkedAt: "2026-11-03T00:00:00.000Z",
      message: null,
    };
    await using screen = await render(grokSection({ version: "1.0.70" }));
    const update = screen.getByRole("button", { name: "Update Grok", exact: true });
    await expect.element(update).not.toBeInTheDocument();
    await screen.rerender(
      grokSection({ versionAdvisory: { ...advisory, status: "unknown", latestVersion: null } }),
    );
    await expect.element(update).not.toBeInTheDocument();
    await screen.rerender(grokSection({ versionAdvisory: advisory }));
    await expect.element(update).toBeEnabled();
    await update.click();
    expect(setup.startInstall).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    await screen.rerender(
      grokSection({
        version: "1.0.71",
        versionAdvisory: { ...advisory, status: "current", currentVersion: "1.0.71" },
      }),
    );
    await expect.element(update).not.toBeInTheDocument();
  });

  it("explains API-key authentication and respects read-only access", async () => {
    resetSetup();
    await using screen = await render(
      grokSection({ setup: { canAuthenticate: false, canInstall: true } }),
    );
    expect(screen.container.textContent).toContain("XAI_API_KEY");
    await expect
      .element(screen.getByRole("button", { name: "Sign in", exact: true }))
      .not.toBeInTheDocument();
    await screen.rerender(grokSection({}, true));
    expect(screen.container.textContent).toContain("Provider setup is read-only.");
    await expect
      .element(screen.getByRole("button", { name: "Install Grok", exact: true }))
      .not.toBeInTheDocument();
  });
});

describe("Antigravity setup", () => {
  it("can start installation before the first install snapshot arrives", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    const idleInstallation = setup.installation!;
    setup.installation = null;
    let resolveStart!: () => void;
    const command = new Promise<{ _tag: "Success"; value: undefined }>((resolve) => {
      resolveStart = () => resolve({ _tag: "Success", value: undefined });
    });
    setup.startInstall.mockReturnValueOnce(command);
    await using screen = await renderSetup({ provider: { ...provider, installed: false } });

    await screen.click("Install Antigravity");
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Starting installation." }))
      .toBeVisible();

    setup.installation = {
      ...idleInstallation,
      operationId: "install-1",
      phase: "downloading",
      downloadedBytes: 1_000_000,
      totalBytes: 2_000_000,
    };
    await publish();
    await expect
      .element(screen.getByRole("button", { name: "Cancel installation" }))
      .toBeDisabled();
    await act(async () => resolveStart());
    await expect.element(screen.getByRole("button", { name: "Cancel installation" })).toBeEnabled();
    await expect
      .element(screen.getByRole("status").filter({ hasText: "Downloading 1.0 MB of 2.0 MB." }))
      .toBeVisible();
  });

  it("waits for verified auth after submitting a callback to the selected environment", async () => {
    resetSetup();
    const callbackUrl = "http://127.0.0.1:5555/?state=test-only&code=test-only";
    await using screen = await renderSetup();
    await userEvent.fill(screen.callbackInput(), callbackUrl);
    await screen.click("Continue");

    expect(setup.completeAuth).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, flowId: "flow-1", callbackUrl },
    });
    expect(screen.occurrences("Signed in.")).toBe(0);
    expect(screen.callbackInput().value).toBe("");

    setup.auth = authState({ phase: "verifying", authorizationUrl: null });
    await publish();
    expect(screen.occurrences("Signed in.")).toBe(0);
    setup.auth = authState({ phase: "succeeded", authorizationUrl: null });
    await screen.rerender(
      section({
        provider: { ...provider, status: "ready", auth: { status: "authenticated" } },
      }),
    );
    expect(screen.occurrences("Signed in.")).toBe(1);
  });

  it("does not send a callback left over from a replaced sign-in flow", async () => {
    resetSetup();
    const interaction = {
      type: "browser" as const,
      id: "same-interaction",
      url: "https://example.com/login",
      requiresConsent: false,
      acceptsCallback: true,
    };
    setup.auth = authState({ interaction });
    await using screen = await renderSetup();
    await userEvent.fill(
      screen.callbackInput(),
      "http://127.0.0.1:5555/?state=old-flow&code=test-only",
    );
    setup.auth = authState({ flowId: "flow-2", interaction });
    await publish();
    expect(screen.callbackInput().value).toBe("");
    await act(async () => screen.callbackInput().form!.requestSubmit());

    expect(setup.completeAuth).not.toHaveBeenCalled();
    expect(setup.authState).toHaveBeenLastCalledWith({ environmentId, input: { instanceId } });
  });

  it("does not let a shared managed install hide an invalid custom binary path", async () => {
    resetSetup();
    setup.auth = authState({ phase: "idle", flowId: null, authorizationUrl: null });
    setup.installation = {
      ...setup.installation!,
      installedVersion: "test-version",
      canRemove: true,
    };
    await using screen = await renderSetup({
      provider: { ...provider, installed: false },
      binaryPath: "/missing/antigravity",
    });
    expect(screen.button("Sign in")?.disabled).toBe(true);
    expect(setup.startAuth).not.toHaveBeenCalled();
  });
});
