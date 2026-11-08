import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  phase: "idle" as ProviderAuthState["phase"],
  confirm: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../../state/query", async (original) => ({
  ...(await original<typeof import("../../state/query")>()),
  useEnvironmentQuery: () => ({
    error: null,
    data: {
      instanceId: ProviderInstanceId.make("codex"),
      phase: state.phase,
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      methods: [
        { id: "default", name: "Sign in", description: null, type: "agent" },
        {
          id: "incomplete",
          name: "Incomplete account",
          canRemove: true,
          description: null,
          type: "agent",
        },
        {
          id: "complete",
          name: "Complete account",
          canRemove: false,
          description: null,
          type: "agent",
        },
      ],
    } satisfies ProviderAuthState,
  }),
}));
vi.mock("../../state/use-atom-command", async (original) => ({
  ...(await original<typeof import("../../state/use-atom-command")>()),
  useAtomCommand: (command: unknown) =>
    command === serverEnvironment.removeProviderAuthMethod
      ? state.remove
      : vi.fn().mockResolvedValue({ _tag: "Success" }),
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: () => ({ dialogs: { confirm: state.confirm } }) as never,
}));

import { serverEnvironment } from "../../state/server";
import { ProviderAuthenticationSection } from "./ProviderAuthenticationSection";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "0.166.0",
  status: "ready",
  auth: { status: "unauthenticated" },
  checkedAt: "2026-11-07T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

it("removes only an incomplete connection after confirmation and respects read-only state", async () => {
  state.phase = "idle";
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
  state.confirm.mockReset().mockResolvedValue(false);
  const section = (readOnly = false) => (
    <ProviderAuthenticationSection
      environmentId={environmentId}
      environmentLabel="this computer"
      instanceId={instanceId}
      provider={provider}
      readOnly={readOnly}
    />
  );
  await using screen = await render(section());
  await screen.getByRole("combobox", { name: "Sign-in method" }).click();
  await page.getByRole("option", { name: "Complete account", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Remove connection" }))
    .not.toBeInTheDocument();
  await screen.getByRole("combobox", { name: "Sign-in method" }).click();
  await page.getByRole("option", { name: "Incomplete account", exact: true }).click();
  await screen.getByRole("button", { name: "Remove connection" }).click();
  expect(state.remove).not.toHaveBeenCalled();
  state.confirm.mockResolvedValue(true);
  await screen.rerender(section(true));
  await expect.element(screen.getByRole("button", { name: "Remove connection" })).toBeDisabled();
  await screen.rerender(section());
  await screen.getByRole("button", { name: "Remove connection" }).click();
  await vi.waitFor(() =>
    expect(state.remove).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, methodId: "incomplete" },
    }),
  );
});
