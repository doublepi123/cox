import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";
import { makeThreadFixture } from "../../test-fixtures";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  threadModes: false,
}));
const destinationId = ThreadId.make("destination");
const destinationThreads = [
  makeThreadFixture({
    id: destinationId,
    environmentId,
    projectId,
    title: "Investigate queue recovery",
  }),
  makeThreadFixture({
    id: ThreadId.make("archived"),
    environmentId,
    projectId,
    title: "Archived recovery",
    archivedAt: "2026-01-01T00:00:00.000Z",
  }),
  makeThreadFixture({
    id: ThreadId.make("foreign"),
    environmentId,
    projectId: ProjectId.make("other"),
    title: "Other project recovery",
  }),
];
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();
const connectionOverride = Atom.make<boolean | null>(null);
const savedTasks = vi.hoisted(() =>
  vi
    .fn<
      (input: {
        environmentId: EnvironmentId;
        input: ScheduledTaskUpsertInput;
      }) => Promise<{ _tag: "Success" }>
    >()
    .mockResolvedValue({ _tag: "Success" }),
);
const providers: ReadonlyArray<ServerProvider> = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.166.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { slug: "gpt-5.4", name: "GPT-5.4", isDefault: true, isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
  },
];
const providerList = Atom.make<ReadonlyArray<ServerProvider> | null>(providers);

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.threadModes = false;
  savedTasks.mockClear();
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

function environment(connected = state.connected) {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: connected ? "connected" : "offline" },
    serverConfig: connected
      ? {
          environment: {
            platform: "linux",
            capabilities: { scheduledTaskThreadModes: state.threadModes },
          },
        }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: () => providerList,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : { tasks: state.tasksLoaded ? [task] : [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (command: unknown) =>
    command === serverEnvironment.upsertScheduledTask
      ? savedTasks
      : vi.fn().mockResolvedValue({ _tag: "Success" }),
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
import { serverEnvironment } from "../../state/server";
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) => {
    const connected = useAtomValue(connectionOverride);
    return id === secondaryId ? secondaryEnvironment() : environment(connected ?? state.connected);
  }) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
  useThreadShells: (enabled = true) => (enabled ? destinationThreads : []),
  useThreadShell: (ref) => (ref?.threadId === destinationId ? destinationThreads[0]! : null),
}));
vi.mock(import("../../state/queries"), async (original) => ({
  ...(await original()),
  useThreadSearch: vi.fn(),
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it.each([390, 1280])(
    "moves an existing task to a matching thread at %spx without changing its prompt",
    async (width) => {
      setup();
      await page.viewport(width, 850);
      const registry = AtomRegistry.make();
      using _registry = { [Symbol.dispose]: () => registry.dispose() };
      registry.set(connectionOverride, true);
      await using _screen = await render(
        <RegistryContext.Provider value={registry}>
          <ScheduledTasksSettings taskId={task.id} />
        </RegistryContext.Provider>,
      );
      const destination = page.getByLabelText("Destination", { exact: true });
      await expect.element(destination).toHaveTextContent("Fix login bug");
      await destination.click();
      await expect
        .element(page.getByRole("option", { name: "New thread each run", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("combobox", { name: "Search threads" }).fill("recovery");
      await expect
        .element(page.getByRole("option", { name: "Investigate queue recovery", exact: true }))
        .toBeVisible();
      await expect
        .element(page.getByRole("option", { name: "Archived recovery", exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByRole("option", { name: "Other project recovery", exact: true }))
        .not.toBeInTheDocument();
      await page.getByRole("option", { name: "Investigate queue recovery", exact: true }).click();
      await expect.element(destination).toHaveTextContent("Investigate queue recovery");
      await expect
        .element(page.getByRole("textbox", { name: "Prompt", exact: true }))
        .toHaveValue(task.prompt);
      expect(destination.element().getBoundingClientRect().right).toBeLessThanOrEqual(width);
      await act(() => registry.set(connectionOverride, false));
      await expect.element(destination).toBeDisabled();
      await act(() => registry.set(connectionOverride, true));
      await expect.element(destination).toBeEnabled();
      await page.getByRole("button", { name: "Save task", exact: true }).click();
      expect(savedTasks).toHaveBeenCalledOnce();
      expect(savedTasks.mock.calls[0]?.[0]).toMatchObject({
        environmentId,
        input: { id: task.id, projectId, threadId: destinationId, prompt: task.prompt },
      });
    },
  );

  it("can leave a bound thread for new-thread mode while preserving the task draft", async () => {
    setup();
    state.threadModes = true;
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const destination = page.getByRole("combobox", { name: "Destination thread" });
    await destination.click();
    await page.getByRole("option", { name: "New thread each run", exact: true }).click();
    await expect.element(destination).not.toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Destination", { exact: true }))
      .toHaveTextContent("New thread each run");
    await expect
      .element(page.getByRole("textbox", { name: "Prompt", exact: true }))
      .toHaveValue(task.prompt);
  });
  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });

  it("names disconnected environments with a Chinese connection status", async () => {
    setup();
    state.secondary = true;
    state.connected = false;
    setLanguagePreference("zh");
    using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
    await using _screen = await render(<ScheduledTasksSettings />);
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("未连接： Laptop (离线), Secondary (离线)");
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });
});
