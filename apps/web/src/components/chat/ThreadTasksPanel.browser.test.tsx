import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ projection: null as unknown }));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() =>
    state.projection === null ? null : { projection: state.projection }) as never,
}));

import { act, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { LANGUAGE_STORAGE_KEY, parseLanguagePreference } from "../../i18n/language";
import { ThreadTasksPanel } from "./ThreadTasksPanel";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");

type Status = "pending" | "running" | "completed";

function todoProjection(runs: number, steps: ReadonlyArray<readonly [string, Status]>) {
  return {
    runs: Array.from({ length: runs }, (_, index) => ({
      id: `run-${index + 1}`,
      ordinal: index + 1,
    })),
    plans: [
      {
        id: "plan",
        kind: "todo_list",
        runId: "run-1",
        status: "active",
        steps: steps.map(([text, status], index) => ({ id: `step-${index}`, text, status })),
      },
    ],
  };
}

function languageScope() {
  const preference = parseLanguagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  setLanguagePreference("en");
  return {
    [Symbol.dispose]() {
      state.projection = null;
      setLanguagePreference(preference);
    },
  };
}

it("lists the current tasks and their progress, then hides a finished list once a new run starts", async () => {
  using _language = languageScope();
  state.projection = todoProjection(1, [
    ["Inspect the install flow", "completed"],
    ["Migrate to the npm package", "running"],
    ["Run the smoke tests", "pending"],
  ]);
  await using screen = await render(
    <ThreadTasksPanel environmentId={environmentId} threadId={threadId} />,
  );
  await expect.element(screen.getByRole("heading", { name: "Tasks" })).toBeVisible();
  await expect.element(screen.getByLabelText("1 of 3 tasks completed")).toHaveTextContent("1/3");
  expect(
    [...screen.container.querySelectorAll("[data-task-status]")].map((row) => row.textContent),
  ).toEqual([
    "Task completed Inspect the install flow",
    "Task in progress Migrate to the npm package",
    "Task pending Run the smoke tests",
  ]);

  await act(() => setLanguagePreference("zh"));
  await expect.element(screen.getByRole("heading", { name: "任务" })).toBeVisible();
  await expect.element(screen.getByLabelText("已完成 1/3 项任务")).toBeVisible();
  expect(screen.container.querySelector('[data-task-status="running"]')?.textContent).toBe(
    "进行中 Migrate to the npm package",
  );

  state.projection = todoProjection(2, [
    ["Inspect the install flow", "completed"],
    ["Migrate to the npm package", "completed"],
  ]);
  await screen.rerender(<ThreadTasksPanel environmentId={environmentId} threadId={threadId} />);
  expect(screen.container.querySelector("[data-thread-tasks-panel]")).toBeNull();
});

it("renders nothing for a thread without a task list", async () => {
  using _language = languageScope();
  state.projection = { runs: [{ id: "run-1", ordinal: 1 }], plans: [] };
  await using screen = await render(
    <ThreadTasksPanel environmentId={environmentId} threadId={threadId} />,
  );
  expect(screen.container.querySelector("[data-thread-tasks-panel]")).toBeNull();
});
