import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ subagents: [] as ReadonlyArray<OrchestrationV2Subagent> }));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() => ({ projection: { subagents: state.subagents } })) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironmentProviders: (() => new Map([[environmentId, [provider]]])) as never,
}));

import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { LANGUAGE_STORAGE_KEY, parseLanguagePreference } from "../../i18n/language";
import { ThreadSubagentsPanel } from "./ThreadSubagentsPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("parent");
const provider = Schema.decodeSync(ServerProvider)({
  instanceId: "codex-review",
  driver: "codex",
  displayName: "Review instance",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-01T00:00:00.000Z",
  models: [],
});

function agent(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return {
    id: NodeId.make("review"),
    threadId,
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "app_owned",
    createdBy: "user",
    driver: provider.driver,
    providerInstanceId: ProviderInstanceId.make("codex-review"),
    providerThreadId: null,
    childThreadId: ThreadId.make("child"),
    nativeTaskRef: null,
    prompt: "Review the changes",
    title: "Review task",
    model: "raw-model-name",
    status: "running",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-11-01T00:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-01T00:02:00Z"),
    ...overrides,
  };
}

function languageScope() {
  const preference = parseLanguagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  setLanguagePreference("en");
  return {
    [Symbol.dispose]() {
      state.subagents = [];
      setLanguagePreference(preference);
    },
  };
}

it("shows live instances and their provider/model, with links only for app-owned child threads", async () => {
  using _language = languageScope();
  state.subagents = [
    agent(),
    agent({
      id: NodeId.make("native"),
      origin: "provider_native",
      title: "Native task",
      childThreadId: null,
      status: "waiting",
      progress: "Reading source files",
    }),
    agent({
      id: NodeId.make("queued"),
      title: "Queued task",
      status: "pending",
      childThreadId: null,
      startedAt: null,
    }),
    agent({ id: NodeId.make("finished"), title: "Finished task", status: "completed" }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByRole("heading", { name: "Active subagents" })).toBeVisible();
  await expect.element(screen.getByLabelText("3 active subagents")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open subagent Review task" }))
    .toHaveAttribute("href", "/environment/child");
  await expect.element(screen.getByText("Running", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Waiting", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Queued", { exact: true })).toBeVisible();
  expect(screen.container.querySelectorAll("a")).toHaveLength(1);
  expect(screen.container.textContent).toContain("Review instance · raw-model-name");
  expect(screen.container.textContent).not.toContain("Finished task");

  await act(() => setLanguagePreference("zh"));
  await expect.element(screen.getByRole("heading", { name: "活跃子 Agent" })).toBeVisible();
  await expect.element(screen.getByText("Reading source files", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "打开子 Agent：Review task" }))
    .toBeVisible();
  expect(screen.container.textContent).toContain("Review instance · raw-model-name");

  state.subagents = state.subagents.map((entry) => ({ ...entry, status: "completed" }));
  await screen.rerender(<ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />);
  expect(screen.container.querySelector("[data-thread-subagents-panel]")).toBeNull();
});

it("counts workflow workers without duplicating the coordinator", async () => {
  using _language = languageScope();
  state.subagents = [
    agent({
      workflow: {
        phases: [],
        agents: [
          { index: 1, label: "Worker one", state: "running" },
          { index: 2, label: "Worker two", state: "queued" },
          { index: 3, label: "Finished worker", state: "completed" },
        ],
      },
    }),
  ];
  await using screen = await render(
    <ThreadSubagentsPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByLabelText("2 active subagents")).toBeVisible();
  expect(screen.container.querySelectorAll("[data-subagent-id]")).toHaveLength(2);
  expect(screen.container.textContent).not.toContain("Review task");
});
