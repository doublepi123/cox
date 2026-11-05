import {
  deriveWorkflowGroups,
  projectedSubagentsToRuntime,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { setLanguagePreference } from "../../i18n";
import { ThreadLineageWorkflowRow } from "./ThreadLineageWorkflowRow";

it("separates cached execution duration from live member and phase timers", async () => {
  using _timers = fakeTimers();
  setLanguagePreference("zh");
  using _language = { [Symbol.dispose]: () => setLanguagePreference("system") };
  vi.setSystemTime(new Date("2026-11-05T14:00:05.000Z"));
  const now = DateTime.makeUnsafe("2026-11-05T14:00:00.000Z");
  const group = deriveWorkflowGroups(
    projectedSubagentsToRuntime([
      {
        id: "workflow",
        title: "Review and Verify",
        prompt: "Review",
        model: null,
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        workflow: {
          phases: [{ index: 1, title: "Review and Verify" }],
          agents: [
            {
              index: 1,
              phaseIndex: 1,
              label: "cached known",
              state: "completed",
              cached: true,
              startedAt: 1000,
              completedAt: 1984254,
              durationMs: 1983254,
            },
            { index: 2, phaseIndex: 1, label: "cached unknown", state: "completed", cached: true },
            {
              index: 3,
              phaseIndex: 1,
              label: "verify",
              state: "running",
              startedAt: DateTime.toEpochMillis(now),
            },
          ],
        },
      },
    ]),
  )[0]!;
  await using screen = await render(
    <ul>
      <ThreadLineageWorkflowRow
        group={group}
        header={<span>Workflow</span>}
        providerInstanceId={ProviderInstanceId.make("claude-test")}
        provider={undefined}
        providers={undefined}
        driver={undefined}
        onOpenThread={() => {}}
        stopping={false}
        stopDisabled={true}
      />
    </ul>,
  );
  await screen.getByRole("button", { name: "Expand Review and Verify", exact: true }).click();
  await expect
    .element(screen.getByText("已复用缓存 · 原耗时 33m 03s", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("已复用缓存 · 原耗时未知", { exact: true })).toBeVisible();
  const verify = screen.getByLabelText("Open verify chat");
  expect(verify.element().textContent).toContain("5s");
  const phase = screen.getByRole("button", {
    name: "Collapse Review and Verify phase, running",
    exact: true,
  });
  expect(phase.element().textContent).toContain("5s");
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(verify.element().textContent).toContain("7s");
  expect(phase.element().textContent).toContain("7s");
});
